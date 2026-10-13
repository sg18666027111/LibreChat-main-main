import { createUserModel } from './user';
import { createTokenModel } from './token';
import { createSessionModel } from './session';
import { createBalanceModel } from './balance';
import { createConversationModel } from './convo';
import { createMessageModel } from './message';
import { createAgentModel } from './agent';
import { createAgentApiKeyModel } from './agentApiKey';
import { createAgentCategoryModel } from './agentCategory';
import { createMCPServerModel } from './mcpServer';
import { createRoleModel } from './role';
import { createActionModel } from './action';
import { createAssistantModel } from './assistant';
import { createFileModel } from './file';
import { createBannerModel } from './banner';
import { createKeyModel } from './key';
import { createPluginAuthModel } from './pluginAuth';
import { createTransactionModel } from './transaction';
import { createPresetModel } from './preset';
import { createPromptModel } from './prompt';
import { createPromptGroupModel } from './promptGroup';
import { createSkillModel } from './skill';
import { createSkillFileModel } from './skillFile';
import { createConversationTagModel } from './conversationTag';
import { createSharedLinkModel } from './sharedLink';
import { createToolCallModel } from './toolCall';
import { createMemoryModel } from './memory';
import { createAccessRoleModel } from './accessRole';
import { createAclEntryModel } from './aclEntry';
import { createSystemGrantModel } from './systemGrant';
import { createGroupModel } from './group';
import { createConfigModel } from './config';
import { createImagePromptTemplateModel } from './imagePromptTemplate';
import { createImagePromptTemplatePermissionLogModel } from './imagePromptTemplatePermissionLog';
import { createImageBatchTaskModel } from './imageBatchTask';
import { createImageGenerationJobModel } from './imageGenerationJob';
import { createImageEgressWorkerSlotModel } from './imageEgressWorkerSlot';
import { createImageProviderConcurrencyLeaseModel } from './imageProviderConcurrencyLease';
import {
  createAdminAuditLogModel,
  createAIModelPriceModel,
  createAIUsageEventModel,
  createUsageReportDeliveryModel,
  createUsageReportModel,
  createUsageReportSettingsModel,
} from './aiUsage';
import {
  createAdminMutationLockModel,
  createEmailBlocklistModel,
  createUserDeletionJobModel,
} from './adminAccount';
import { createSkuBatchTaskModel } from './skuBatchTask';

/**
 * Creates all database models for all collections
 */
export function createModels(mongoose: typeof import('mongoose')) {
  return {
    User: createUserModel(mongoose),
    Token: createTokenModel(mongoose),
    Session: createSessionModel(mongoose),
    Balance: createBalanceModel(mongoose),
    Conversation: createConversationModel(mongoose),
    Message: createMessageModel(mongoose),
    Agent: createAgentModel(mongoose),
    AgentApiKey: createAgentApiKeyModel(mongoose),
    AgentCategory: createAgentCategoryModel(mongoose),
    MCPServer: createMCPServerModel(mongoose),
    Role: createRoleModel(mongoose),
    Action: createActionModel(mongoose),
    Assistant: createAssistantModel(mongoose),
    File: createFileModel(mongoose),
    Banner: createBannerModel(mongoose),
    Key: createKeyModel(mongoose),
    PluginAuth: createPluginAuthModel(mongoose),
    Transaction: createTransactionModel(mongoose),
    Preset: createPresetModel(mongoose),
    Prompt: createPromptModel(mongoose),
    PromptGroup: createPromptGroupModel(mongoose),
    Skill: createSkillModel(mongoose),
    SkillFile: createSkillFileModel(mongoose),
    ConversationTag: createConversationTagModel(mongoose),
    SharedLink: createSharedLinkModel(mongoose),
    ToolCall: createToolCallModel(mongoose),
    MemoryEntry: createMemoryModel(mongoose),
    AccessRole: createAccessRoleModel(mongoose),
    AclEntry: createAclEntryModel(mongoose),
    SystemGrant: createSystemGrantModel(mongoose),
    Group: createGroupModel(mongoose),
    Config: createConfigModel(mongoose),
    ImagePromptTemplate: createImagePromptTemplateModel(mongoose),
    ImagePromptTemplatePermissionLog: createImagePromptTemplatePermissionLogModel(mongoose),
    ImageBatchTask: createImageBatchTaskModel(mongoose),
    ImageGenerationJob: createImageGenerationJobModel(mongoose),
    ImageEgressWorkerSlot: createImageEgressWorkerSlotModel(mongoose),
    ImageProviderConcurrencyLease: createImageProviderConcurrencyLeaseModel(mongoose),
    AIUsageEvent: createAIUsageEventModel(mongoose),
    AIModelPrice: createAIModelPriceModel(mongoose),
    UsageReport: createUsageReportModel(mongoose),
    UsageReportDelivery: createUsageReportDeliveryModel(mongoose),
    UsageReportSettings: createUsageReportSettingsModel(mongoose),
    AdminAuditLog: createAdminAuditLogModel(mongoose),
    UserDeletionJob: createUserDeletionJobModel(mongoose),
    EmailBlocklist: createEmailBlocklistModel(mongoose),
    AdminMutationLock: createAdminMutationLockModel(mongoose),
    SkuBatchTask: createSkuBatchTaskModel(mongoose),
  };
}
