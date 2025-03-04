import {
    SchemaEntity,
    SchemaStatus,
    TopicType,
    ModelHelper,
    SchemaHelper,
    Schema,
    UserRole,
    IUser,
    PolicyType,
    IRootConfig,
    GenerateUUIDv4, PolicyEvents
} from '@guardian/interfaces';
import {
    DataBaseHelper,
    IAuthUser,
    Logger, ServiceRequestsBase, Singleton
} from '@guardian/common';
import {
    MessageAction,
    MessageServer,
    MessageType,
    PolicyMessage,
    SynchronizationMessage,
    TokenMessage,
    TopicConfig,
    TopicHelper
} from '@hedera-modules'
import { findAllEntities, getArtifactType, replaceAllEntities, replaceArtifactProperties, SchemaFields } from '@helpers/utils';
import { IPolicyInstance } from './policy-engine.interface';
import { incrementSchemaVersion, findAndPublishSchema, findAndDryRunSchema, deleteSchema, publishSystemSchemas } from '@api/schema.service';
import { PolicyImportExportHelper } from './helpers/policy-import-export-helper';
import { VcHelper } from '@helpers/vc-helper';
import { Users } from '@helpers/users';
import { Inject } from '@helpers/decorators/inject';
import { Policy } from '@entity/policy';
import { Topic } from '@entity/topic';
import { PolicyConverterUtils } from './policy-converter-utils';
import { DatabaseServer } from '@database-modules';
import { IPolicyUser, PolicyUser } from './policy-user';
import { emptyNotifier, INotifier } from '@helpers/notifier';
import { ISerializedErrors } from './policy-validation-results-container';
import { Artifact } from '@entity/artifact';
import { MultiPolicy } from '@entity/multi-policy';
import { PolicyServiceChannelsContainer } from '@helpers/policy-service-channels-container';

/**
 * Result of publishing
 */
interface IPublishResult {
    /**
     * Policy Id
     */
    policyId: string;
    /**
     * Is policy valid
     */
    isValid: boolean;
    /**
     * Errors of validation
     */
    errors: ISerializedErrors;
}

/**
 * Policy engine service
 */
@Singleton
export class PolicyEngine extends ServiceRequestsBase{

    /**
     * Run ready event
     * @param policyId
     * @param data
     */
    public static runReadyEvent(policyId: string, data: any): void {
        new PolicyEngine().runReadyEvent(policyId, data);
    }

    /**
     * Target
     */
    public target: string = 'policy-service';

    /**
     * Users helper
     * @private
     */
    @Inject()
    private readonly users: Users;

    /**
     * Policy ready callbacks
     * @private
     */
    private readonly policyReadyCallbacks: Map<string, (data: any) => void> = new Map();

    /**
     * Initialization
     */
    public async init(): Promise<void> {
        const policies = await DatabaseServer.getPolicies({
            where: {
                status: { $in: [PolicyType.PUBLISH, PolicyType.DRY_RUN] }
            }
        });
        await Promise.all(policies.map(async (policy) => {
            try {
                await this.generateModel(policy.id.toString());
            } catch (error) {
                new Logger().error(error, ['GUARDIAN_SERVICE']);
            }
        }));
    }

    /**
     * Run ready event
     * @param policyId
     * @param data
     */
    private runReadyEvent(policyId: string, data?: any): void {
        console.log('policy ready', policyId);
        if (this.policyReadyCallbacks.has(policyId)) {
            this.policyReadyCallbacks.get(policyId)(data);
        }
    }

    /**
     * Get user
     * @param policy
     * @param user
     */
    public async getUser(policy: IPolicyInstance, user: IUser): Promise<IPolicyUser> {
        const regUser = await this.users.getUser(user.username);
        if (!regUser || !regUser.did) {
            throw new Error(`Forbidden`);
        }
        const userFull = new PolicyUser(regUser.did);
        if (policy.dryRun) {
            if (user.role === UserRole.STANDARD_REGISTRY) {
                const virtualUser = await DatabaseServer.getVirtualUser(policy.policyId);
                userFull.setVirtualUser(virtualUser);
            } else {
                throw new Error(`Forbidden`);
            }
        } else {
            userFull.setUsername(regUser.username);
        }
        const groups = await policy.databaseServer.getGroupsByUser(policy.policyId, userFull.did);
        for (const group of groups) {
            if (group.active !== false) {
                return userFull.setGroup(group);
            }
        }
        return userFull;
    }

    /**
     * Create policy
     * @param data
     * @param owner
     */
    public async createPolicy(data: Policy, owner: string, notifier: INotifier): Promise<Policy> {
        const logger = new Logger();
        logger.info('Create Policy', ['GUARDIAN_SERVICE']);
        notifier.start('Save in DB');
        if (data) {
            delete data.status;
        }
        const model = DatabaseServer.createPolicy(data);
        let artifacts = [];
        if (model.uuid) {
            const old = await DatabaseServer.getPolicyByUUID(model.uuid);
            if (model.creator !== owner) {
                throw new Error('Invalid owner');
            }
            if (old.creator !== owner) {
                throw new Error('Invalid owner');
            }
            model.creator = owner;
            model.owner = owner;
            delete model.version;
            delete model.messageId;
            artifacts = await DatabaseServer.getArtifacts({
                policyId: old.id
            });
        } else {
            model.creator = owner;
            model.owner = owner;
            delete model.previousVersion;
            delete model.topicId;
            delete model.version;
            delete model.messageId;
        }

        let newTopic: Topic;
        notifier.completedAndStart('Resolve Hedera account');
        const root = await this.users.getHederaAccount(owner);
        notifier.completed();
        if (!model.topicId) {
            notifier.start('Create topic');
            logger.info('Create Policy: Create New Topic', ['GUARDIAN_SERVICE']);
            const parent = await TopicConfig.fromObject(
                await DatabaseServer.getTopicByType(owner, TopicType.UserTopic), true
            );
            const topicHelper = new TopicHelper(root.hederaAccountId, root.hederaAccountKey);
            const topic = await topicHelper.create({
                type: TopicType.PolicyTopic,
                name: model.name || TopicType.PolicyTopic,
                description: model.topicDescription || TopicType.PolicyTopic,
                owner,
                policyId: null,
                policyUUID: null
            });
            await topic.saveKeys();

            model.topicId = topic.topicId;

            notifier.completedAndStart('Create policy in Hedera');
            const messageServer = new MessageServer(root.hederaAccountId, root.hederaAccountKey);
            const message = new PolicyMessage(MessageType.Policy, MessageAction.CreatePolicy);
            message.setDocument(model);
            const messageStatus = await messageServer
                .setTopicObject(parent)
                .sendMessage(message);

            notifier.completedAndStart('Link topic and policy');
            await topicHelper.twoWayLink(topic, parent, messageStatus.getId());

            notifier.completedAndStart('Publish schemas');
            const systemSchemas = await PolicyImportExportHelper.getSystemSchemas();

            notifier.info(`Found ${systemSchemas.length} schemas`);
            messageServer.setTopicObject(topic);

            await publishSystemSchemas(systemSchemas, messageServer, owner, notifier);

            newTopic = await DatabaseServer.saveTopic(topic.toObject());
            notifier.completed();
        }

        notifier.start('Create Artifacts');
        const artifactsMap = new Map<string, string>();
        const addedArtifacts = [];
        for (const artifact of artifacts) {
            artifact.data = await DatabaseServer.getArtifactFileByUUID(artifact.uuid);
            delete artifact._id;
            delete artifact.id;
            const newArtifactUUID = GenerateUUIDv4();
            artifactsMap.set(artifact.uuid, newArtifactUUID);
            artifact.owner = model.owner;
            artifact.uuid = newArtifactUUID;
            artifact.type = getArtifactType(artifact.extention);
            addedArtifacts.push(await DatabaseServer.saveArtifact(artifact));
            await DatabaseServer.saveArtifactFile(newArtifactUUID, artifact.data);
        }
        replaceArtifactProperties(model.config, 'uuid', artifactsMap);

        notifier.completedAndStart('Saving in DB');
        model.codeVersion = PolicyConverterUtils.VERSION;
        const policy = await DatabaseServer.updatePolicy(model);

        if (newTopic) {
            newTopic.policyId = policy.id.toString();
            newTopic.policyUUID = policy.uuid;
            await DatabaseServer.updateTopic(newTopic);
        }

        for (const addedArtifact of addedArtifacts) {
            addedArtifact.policyId = policy.id;
            await DatabaseServer.saveArtifact(addedArtifact);
        }

        notifier.completed();
        return policy;
    }

    /**
     * Clone policy
     * @param policyId
     * @param data
     * @param owner
     * @param notifier
     */
    public async clonePolicy(
        policyId: string,
        data: any,
        owner: string,
        notifier: INotifier
    ): Promise<{
        /**
         * New Policy
         */
        policy: Policy;
        /**
         * Errors
         */
        errors: any[];
    }> {
        const logger = new Logger();
        logger.info('Create Policy', ['GUARDIAN_SERVICE']);

        const policy = await DatabaseServer.getPolicyById(policyId);
        if (!policy) {
            throw new Error('Policy does not exists');
        }
        if (policy.creator !== owner) {
            throw new Error('Invalid owner');
        }

        const schemas = await DatabaseServer.getSchemas({
            topicId: policy.topicId,
            readonly: false
        });

        const tokenIds = findAllEntities(policy.config, ['tokenId']);
        const tokens = await DatabaseServer.getTokens({
            tokenId: { $in: tokenIds }
        });

        const artifacts: any = await DatabaseServer.getArtifacts({
            policyId: policy.id
        });

        for (const artifact of artifacts) {
            artifact.data = await DatabaseServer.getArtifactFileByUUID(artifact.uuid);
        }

        const dataToCreate = {
            policy, schemas, tokens, artifacts
        };
        return await PolicyImportExportHelper.importPolicy(dataToCreate, owner, null, notifier, data);
    }

    /**
     * Delete policy
     * @param policyId Policy ID
     * @param user User
     * @param notifier Notifier
     * @returns Result
     */
    public async deletePolicy(policyId: string, user: IAuthUser, notifier: INotifier): Promise<boolean> {
        const logger = new Logger();
        logger.info('Delete Policy', ['GUARDIAN_SERVICE']);

        const policyToDelete = await DatabaseServer.getPolicyById(policyId);
        if (policyToDelete.owner !== user.did) {
            throw new Error('Insufficient permissions to delete the policy');
        }

        if (policyToDelete.status !== PolicyType.DRAFT) {
            throw new Error('Policy is not in draft status');
        }

        notifier.start('Delete schemas');
        const schemasToDelete = await DatabaseServer.getSchemas({
            topicId: policyToDelete.topicId,
            readonly: false
        });
        for (const schema of schemasToDelete) {
            if (schema.status === SchemaStatus.DRAFT) {
                await deleteSchema(schema.id, notifier);
            }
        }
        notifier.completedAndStart('Delete artifacts');
        const artifactsToDelete = await new DataBaseHelper(Artifact).find({
            policyId: policyToDelete.id
        });
        for (const artifact of artifactsToDelete) {
            await DatabaseServer.removeArtifact(artifact);
        }

        notifier.completedAndStart('Publishing delete policy message');
        const topic = await TopicConfig.fromObject(await DatabaseServer.getTopicById(policyToDelete.topicId), true);
        const users = new Users();
        const root = await users.getHederaAccount(policyToDelete.owner);
        const messageServer = new MessageServer(root.hederaAccountId, root.hederaAccountKey);
        const message = new PolicyMessage(MessageType.Policy, MessageAction.DeletePolicy);
        message.setDocument(policyToDelete);
        await messageServer.setTopicObject(topic)
            .sendMessage(message);

        notifier.completedAndStart('Delete policy from DB');
        await DatabaseServer.deletePolicy(policyId);
        notifier.completed();
        return true;
    }

    /**
     * Policy schemas
     * @param model
     * @param owner
     * @param root
     * @param notifier
     */
    public async publishSchemas(model: Policy, owner: string, root: IRootConfig, notifier: INotifier): Promise<Policy> {
        const schemas = await DatabaseServer.getSchemas({ topicId: model.topicId });
        notifier.info(`Found ${schemas.length} schemas`);
        const schemaIRIs = schemas.map(s => s.iri);
        let num: number = 0;
        let skipped: number = 0;
        for (const schemaIRI of schemaIRIs) {
            const schema = await incrementSchemaVersion(schemaIRI, owner);
            if (!schema || schema.status === SchemaStatus.PUBLISHED) {
                skipped++;
                continue;
            }
            const newSchema = await findAndPublishSchema(
                schema.id,
                schema.version,
                owner,
                root,
                emptyNotifier()
            );
            replaceAllEntities(model.config, SchemaFields, schemaIRI, newSchema.iri);

            const name = newSchema.name;
            num++;
            notifier.info(`Schema ${num} (${name || '-'}) published`);
        }

        if (skipped) {
            notifier.info(`Skip published ${skipped}`);
        }
        return model;
    }

    /**
     * Dry run Policy schemas
     * @param model
     * @param owner
     */
    public async dryRunSchemas(model: Policy, owner: string): Promise<Policy> {
        const schemas = await DatabaseServer.getSchemas({ topicId: model.topicId });
        for (const schema of schemas) {
            if (schema.status === SchemaStatus.PUBLISHED) {
                continue;
            }
            await findAndDryRunSchema(schema, schema.version, owner);
        }
        return model;
    }

    /**
     * Publish policy
     * @param model
     * @param owner
     * @param version
     * @param notifier
     */
    public async publishPolicy(model: Policy, owner: string, version: string, notifier: INotifier): Promise<Policy> {
        const logger = new Logger();
        logger.info('Publish Policy', ['GUARDIAN_SERVICE']);
        notifier.start('Resolve Hedera account');
        const root = await this.users.getHederaAccount(owner);
        notifier.completedAndStart('Find topic');

        model.version = version;

        const topic = await TopicConfig.fromObject(await DatabaseServer.getTopicById(model.topicId), true);
        const messageServer = new MessageServer(root.hederaAccountId, root.hederaAccountKey)
            .setTopicObject(topic);

        notifier.completedAndStart('Publish schemas');
        try {
            model = await this.publishSchemas(model, owner, root, notifier);
        } catch (error) {
            model.status = PolicyType.PUBLISH_ERROR;
            model.version = '';
            await DatabaseServer.updatePolicy(model);
            throw error;
        }

        try {
            notifier.completedAndStart('Generate file');
            this.regenerateIds(model.config);
            const zip = await PolicyImportExportHelper.generateZipFile(model);
            const buffer = await zip.generateAsync({
                type: 'arraybuffer',
                compression: 'DEFLATE',
                compressionOptions: {
                    level: 3
                }
            });

            notifier.completedAndStart('Token');
            const tokenIds = findAllEntities(model.config, ['tokenId']);
            const tokens = await DatabaseServer.getTokens({tokenId: {$in: tokenIds}, owner: model.owner});
            for (const token of tokens) {
                const tokenMessage = new TokenMessage(MessageAction.UseToken);
                tokenMessage.setDocument(token);
                await messageServer
                    .sendMessage(tokenMessage);
            }
            const topicHelper = new TopicHelper(root.hederaAccountId, root.hederaAccountKey);

            const createInstanceTopic = async () => {
                notifier.completedAndStart('Create instance topic');
                rootTopic = await topicHelper.create({
                    type: TopicType.InstancePolicyTopic,
                    name: model.name || TopicType.InstancePolicyTopic,
                    description: model.topicDescription || TopicType.InstancePolicyTopic,
                    owner,
                    policyId: model.id.toString(),
                    policyUUID: model.uuid
                });
                await rootTopic.saveKeys();
                await DatabaseServer.saveTopic(rootTopic.toObject());
                model.instanceTopicId = rootTopic.topicId;
            }

            let rootTopic;
            if (model.status === PolicyType.PUBLISH_ERROR) {
                if (model.instanceTopicId) {
                    const topicEntity = await DatabaseServer.getTopicById(model.instanceTopicId);
                    rootTopic = await TopicConfig.fromObject(topicEntity);
                }
                if (!rootTopic) {
                    await createInstanceTopic();
                }
            } else {
                await createInstanceTopic();
            }

            const createSynchronizationTopic = async () => {
                notifier.completedAndStart('Create synchronization topic');
                const synchronizationTopic = await topicHelper.create({
                    type: TopicType.SynchronizationTopic,
                    name: model.name || TopicType.SynchronizationTopic,
                    description: model.topicDescription || TopicType.InstancePolicyTopic,
                    owner,
                    policyId: model.id.toString(),
                    policyUUID: model.uuid
                }, {admin: true, submit: false});
                await synchronizationTopic.saveKeys();
                await DatabaseServer.saveTopic(synchronizationTopic.toObject());
                model.synchronizationTopicId = synchronizationTopic.topicId;
            }
            if (model.status === PolicyType.PUBLISH_ERROR) {
                if (!!model.synchronizationTopicId) {
                    await createSynchronizationTopic();
                }
            } else {
                await createSynchronizationTopic();
            }

            notifier.completedAndStart('Publish policy');
            const message = new PolicyMessage(MessageType.InstancePolicy, MessageAction.PublishPolicy);
            message.setDocument(model, buffer);
            const result = await messageServer
                .sendMessage(message);
            model.messageId = result.getId();

            notifier.completedAndStart('Link topic and policy');
            await topicHelper.twoWayLink(rootTopic, topic, result.getId());

            notifier.completedAndStart('Create VC');
            const messageId = result.getId();
            const url = result.getUrl();
            const policySchema = await DatabaseServer.getSchemaByType(model.topicId, SchemaEntity.POLICY);
            const vcHelper = new VcHelper();
            let credentialSubject: any = {
                id: messageId,
                name: model.name,
                description: model.description,
                topicDescription: model.topicDescription,
                version: model.version,
                policyTag: model.policyTag,
                owner: model.owner,
                cid: url.cid,
                url: url.url,
                uuid: model.uuid,
                operation: 'PUBLISH'
            }
            if (policySchema) {
                const schemaObject = new Schema(policySchema);
                credentialSubject = SchemaHelper.updateObjectContext(schemaObject, credentialSubject);
            }
            const vc = await vcHelper.createVC(owner, root.hederaAccountKey, credentialSubject);
            await DatabaseServer.saveVC({
                hash: vc.toCredentialHash(),
                owner,
                document: vc.toJsonTree(),
                type: SchemaEntity.POLICY,
                policyId: `${model.id}`
            });

            logger.info('Published Policy', ['GUARDIAN_SERVICE']);

        } catch (error) {
            model.status = PolicyType.PUBLISH_ERROR;
            model.version = '';
            await DatabaseServer.updatePolicy(model);
            throw error
        }
        notifier.completedAndStart('Saving in DB');
        model.status = PolicyType.PUBLISH;
        const retVal = await DatabaseServer.updatePolicy(model);
        notifier.completed();
        return retVal
    }

    /**
     * Dry Run policy
     * @param model
     * @param owner
     * @param version
     */
    public async dryRunPolicy(model: Policy, owner: string, version: string): Promise<Policy> {
        const logger = new Logger();
        logger.info('Dry-run Policy', ['GUARDIAN_SERVICE']);

        const root = await this.users.getHederaAccount(owner);
        const topic = await TopicConfig.fromObject(await DatabaseServer.getTopicById(model.topicId), true);
        const dryRunId = model.id.toString();
        const messageServer = new MessageServer(root.hederaAccountId, root.hederaAccountKey, dryRunId)
            .setTopicObject(topic);
        const topicHelper = new TopicHelper(root.hederaAccountId, root.hederaAccountKey, dryRunId);
        const databaseServer = new DatabaseServer(dryRunId);

        model = await this.dryRunSchemas(model, owner);
        model.status = PolicyType.DRY_RUN;
        model.version = version;

        this.regenerateIds(model.config);
        const zip = await PolicyImportExportHelper.generateZipFile(model);
        const buffer = await zip.generateAsync({
            type: 'arraybuffer',
            compression: 'DEFLATE',
            compressionOptions: {
                level: 3
            }
        });

        const rootTopic = await topicHelper.create({
            type: TopicType.InstancePolicyTopic,
            name: model.name || TopicType.InstancePolicyTopic,
            description: model.topicDescription || TopicType.InstancePolicyTopic,
            owner,
            policyId: model.id.toString(),
            policyUUID: model.uuid
        });
        await rootTopic.saveKeys();
        await databaseServer.saveTopic(rootTopic.toObject());
        model.instanceTopicId = rootTopic.topicId;

        const message = new PolicyMessage(MessageType.InstancePolicy, MessageAction.PublishPolicy);
        message.setDocument(model, buffer);
        const result = await messageServer.sendMessage(message);
        model.messageId = result.getId();

        await topicHelper.twoWayLink(rootTopic, topic, result.getId());

        const messageId = result.getId();
        const url = result.getUrl();

        const vcHelper = new VcHelper();
        let credentialSubject: any = {
            id: messageId,
            name: model.name,
            description: model.description,
            topicDescription: model.topicDescription,
            version: model.version,
            policyTag: model.policyTag,
            owner: model.owner,
            cid: url.cid,
            url: url.url,
            uuid: model.uuid,
            operation: 'PUBLISH'
        }

        const policySchema = await DatabaseServer.getSchemaByType(model.topicId, SchemaEntity.POLICY);
        if (policySchema) {
            const schemaObject = new Schema(policySchema);
            credentialSubject = SchemaHelper.updateObjectContext(schemaObject, credentialSubject);
        }

        const vc = await vcHelper.createVC(owner, root.hederaAccountKey, credentialSubject);

        await databaseServer.saveVC({
            hash: vc.toCredentialHash(),
            owner,
            document: vc.toJsonTree(),
            type: SchemaEntity.POLICY,
            policyId: `${model.id}`
        });

        await DatabaseServer.createVirtualUser(
            model.id.toString(),
            'Administrator',
            root.did,
            root.hederaAccountId,
            root.hederaAccountKey,
            true
        );

        logger.info('Published Policy', ['GUARDIAN_SERVICE']);

        return await DatabaseServer.updatePolicy(model);
    }

    /**
     * Validate and publish policy
     * @param model
     * @param policyId
     * @param owner
     * @param notifier
     */
    public async validateAndPublishPolicy(model: any, policyId: any, owner: string, notifier: INotifier): Promise<IPublishResult> {
        const version = model.policyVersion;

        notifier.start('Find and validate policy');
        const policy = await DatabaseServer.getPolicyById(policyId);
        if (!policy) {
            throw new Error('Unknown policy');
        }
        if (!policy.config) {
            throw new Error('The policy is empty');
        }
        if (policy.status === PolicyType.PUBLISH) {
            throw new Error(`Policy already published`);
        }
        if (!ModelHelper.checkVersionFormat(version)) {
            throw new Error('Invalid version format');
        }
        if (ModelHelper.versionCompare(version, policy.previousVersion) <= 0) {
            throw new Error('Version must be greater than ' + policy.previousVersion);
        }

        const countModels = await DatabaseServer.getPolicyCount({
            version,
            uuid: policy.uuid
        });
        if (countModels > 0) {
            throw new Error('Policy with current version already was published');
        }

        const errors = await this.validateModel(policyId);
        const isValid = !errors.blocks.some(block => !block.isValid);
        notifier.completed();
        if (isValid) {
            if (policy.status === PolicyType.DRY_RUN) {
                await this.destroyModel(policyId);
                await DatabaseServer.clearDryRun(policy.id.toString());
            }
            const newPolicy = await this.publishPolicy(policy, owner, version, notifier);
            await this.generateModel(newPolicy.id.toString());
            return {
                policyId: newPolicy.id.toString(),
                isValid,
                errors
            };
        } else {
            return {
                policyId: policy.id.toString(),
                isValid,
                errors
            };
        }
    }

    /**
     * Prepare policy for preview by message
     * @param messageId
     * @param user
     * @param notifier
     */
    public async preparePolicyPreviewMessage(messageId: string, user: any, notifier: INotifier): Promise<any> {
        notifier.start('Resolve Hedera account');
        const userFull = await this.users.getUser(user.username);
        if (!messageId) {
            throw new Error('Policy ID in body is empty');
        }

        new Logger().info(`Import policy by message`, ['GUARDIAN_SERVICE']);

        const root = await this.users.getHederaAccount(userFull.did);

        const messageServer = new MessageServer(root.hederaAccountId, root.hederaAccountKey);
        const message = await messageServer.getMessage<PolicyMessage>(messageId);
        if (message.type !== MessageType.InstancePolicy) {
            throw new Error('Invalid Message Type');
        }

        if (!message.document) {
            throw new Error('file in body is empty');
        }

        notifier.completedAndStart('Load policy files');
        const newVersions: any = [];
        if (message.version) {
            const anotherVersions = await messageServer.getMessages<PolicyMessage>(
                message.getTopicId(), MessageType.InstancePolicy, MessageAction.PublishPolicy
            );
            for (const element of anotherVersions) {
                if (element.version && ModelHelper.versionCompare(element.version, message.version) === 1) {
                    newVersions.push({
                        messageId: element.getId(),
                        version: element.version
                    });
                }
            };
        }

        notifier.completedAndStart('Parse policy files');
        const policyToImport = await PolicyImportExportHelper.parseZipFile(message.document);
        if (newVersions.length !== 0) {
            policyToImport.newVersions = newVersions.reverse();
        }

        notifier.completed();
        return policyToImport;
    }

    /**
     * Import policy by message
     * @param messageId
     * @param owner
     * @param hederaAccount
     * @param versionOfTopicId
     * @param notifier
     */
    public async importPolicyMessage(
        messageId: string,
        owner: string,
        hederaAccount: IRootConfig,
        versionOfTopicId: string,
        notifier: INotifier
    ): Promise<{
        /**
         * New Policy
         */
        policy: Policy;
        /**
         * Errors
         */
        errors: any[];
    }> {
        notifier.start('Load from IPFS');
        const messageServer = new MessageServer(hederaAccount.hederaAccountId, hederaAccount.hederaAccountKey);
        const message = await messageServer.getMessage<PolicyMessage>(messageId);
        if (message.type !== MessageType.InstancePolicy) {
            throw new Error('Invalid Message Type');
        }
        if (!message.document) {
            throw new Error('File in body is empty');
        }

        notifier.completedAndStart('File parsing');
        const policyToImport = await PolicyImportExportHelper.parseZipFile(message.document, true);
        notifier.completed();
        return await PolicyImportExportHelper.importPolicy(policyToImport, owner, versionOfTopicId, notifier);
    }

    /**
     * Destroy Model
     * @param policyId
     */
    public async destroyModel(policyId: string): Promise<void> {
        const serviceChannelEntity = PolicyServiceChannelsContainer.getPolicyServiceChannel(policyId);
        if (serviceChannelEntity) {
            const {name} = serviceChannelEntity;
            PolicyServiceChannelsContainer.deletePolicyServiceChannel(policyId);
            this.channel.publish(PolicyEvents.DELETE_POLICY, {
                policyId,
                policyServiceName: name

            });
        }
    }

    /**
     * Generate Model
     * @param policyId
     */
    public async generateModel(policyId: string): Promise<void> {
        const policy = await DatabaseServer.getPolicyById(policyId);
        if (!policy || (typeof policy !== 'object')) {
            throw new Error('Policy was not exist');
        }
        const { name } = PolicyServiceChannelsContainer.createPolicyServiceChannel(policyId);

        this.channel.publish(PolicyEvents.GENERATE_POLICY, {
            policy,
            policyId,
            policyServiceName: name,
            skipRegistration: false
        });

        return new Promise((resolve) => {
            this.policyReadyCallbacks.set(policyId, (data) => {
                resolve(data);
            })
        });
    }

    /**
     * Validate Model
     * @param policy
     */
    public async validateModel(policy: Policy | string): Promise<ISerializedErrors> {
        let policyId: string;

        if (typeof policy === 'string') {
            policyId = policy
            policy = await DatabaseServer.getPolicyById(policyId);
        } else {
            if (!policy.id) {
                policy.id = GenerateUUIDv4();
            }
            policyId = policy.id.toString();
        }

        const { name } = PolicyServiceChannelsContainer.createIfNotExistServiceChannel(policyId);

        this.channel.publish(PolicyEvents.GENERATE_POLICY, {
            policy,
            policyId,
            policyServiceName: name,
            skipRegistration: false
        });

        return new Promise((resolve) => {
            this.policyReadyCallbacks.set(policyId, (data) => {
                this.destroyModel(policyId);
                resolve(data);
            })
        });
    }

    /**
     * Create Multi Policy
     * @param policyInstance
     * @param userAccount
     * @param data
     */
    public async createMultiPolicy(
        policyInstance: IPolicyInstance,
        userAccount: IRootConfig,
        root: IRootConfig,
        data: any,
    ): Promise<MultiPolicy> {

        const multipleConfig = DatabaseServer.createMultiPolicy({
            uuid: GenerateUUIDv4(),
            instanceTopicId: policyInstance.instanceTopicId,
            mainPolicyTopicId: data.mainPolicyTopicId,
            synchronizationTopicId: data.synchronizationTopicId,
            owner: userAccount.did,
            user: userAccount.hederaAccountId,
            policyOwner: root.hederaAccountId,
            type: data.mainPolicyTopicId === policyInstance.instanceTopicId ? 'Main' : 'Sub',
        });

        const message = new SynchronizationMessage(MessageAction.CreateMultiPolicy);
        message.setDocument(multipleConfig);
        const messageServer = new MessageServer(userAccount.hederaAccountId, userAccount.hederaAccountKey);
        const topic = new TopicConfig({ topicId: multipleConfig.synchronizationTopicId }, null, null);
        await messageServer
            .setTopicObject(topic)
            .sendMessage(message);

        return await DatabaseServer.saveMultiPolicy(multipleConfig);
    }

    /**
     * Regenerate IDs
     * @param block
     */
    public regenerateIds(block: any) {
        block.id = GenerateUUIDv4();
        if (Array.isArray(block.children)) {
            for (const child of block.children) {
                this.regenerateIds(child);
            }
        }
    }
}
