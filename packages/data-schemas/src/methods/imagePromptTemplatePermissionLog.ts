import type { FilterQuery, Model } from 'mongoose';
import type {
  CreateImagePromptTemplatePermissionLogInput,
  IImagePromptTemplatePermissionLogDocument,
  ImagePromptTemplatePermissionLogStatus,
} from '~/types/imagePromptTemplatePermissionLog';

const PROMPT_TEMPLATE_PERMISSION = 'imagePromptTemplates.manage';

function getPermissionLogModel(mongoose: typeof import('mongoose')) {
  return mongoose.models
    .ImagePromptTemplatePermissionLog as Model<IImagePromptTemplatePermissionLogDocument>;
}

function cleanText(value?: string) {
  return typeof value === 'string' ? value.trim() : '';
}

export function createImagePromptTemplatePermissionLogMethods(
  mongoose: typeof import('mongoose'),
) {
  async function grantImagePromptTemplatePermissionLog(
    input: Omit<CreateImagePromptTemplatePermissionLogInput, 'permission' | 'status' | 'grantedAt'>,
  ) {
    const PermissionLog = getPermissionLogModel(mongoose);
    const now = new Date();
    const active = await PermissionLog.findOne({
      targetUserId: input.targetUserId,
      permission: PROMPT_TEMPLATE_PERMISSION,
      status: 'active',
      deletedAt: { $exists: false },
    });

    if (active) {
      active.targetUserEmail = cleanText(input.targetUserEmail);
      active.targetUserName = cleanText(input.targetUserName);
      await active.save();
      return active.toObject();
    }

    const revoked = await PermissionLog.findOne({
      targetUserId: input.targetUserId,
      permission: PROMPT_TEMPLATE_PERMISSION,
      status: 'revoked',
      deletedAt: { $exists: false },
    }).sort({ revokedAt: -1, updatedAt: -1 });

    if (revoked) {
      revoked.status = 'active';
      revoked.targetUserEmail = cleanText(input.targetUserEmail);
      revoked.targetUserName = cleanText(input.targetUserName);
      revoked.grantedBy = input.grantedBy;
      revoked.grantedByEmail = cleanText(input.grantedByEmail);
      revoked.grantedAt = now;
      revoked.revokedBy = '';
      revoked.revokedByEmail = '';
      revoked.revokedAt = undefined;
      await revoked.save();
      return revoked.toObject();
    }

    const created = await PermissionLog.create({
      targetUserId: input.targetUserId,
      targetUserEmail: cleanText(input.targetUserEmail),
      targetUserName: cleanText(input.targetUserName),
      permission: PROMPT_TEMPLATE_PERMISSION,
      status: 'active',
      grantedBy: input.grantedBy,
      grantedByEmail: cleanText(input.grantedByEmail),
      grantedAt: now,
    });
    return created.toObject();
  }

  async function revokeImagePromptTemplatePermissionLog({
    targetUserId,
    revokedBy,
    revokedByEmail,
  }: {
    targetUserId: string;
    revokedBy: string;
    revokedByEmail?: string;
  }) {
    const PermissionLog = getPermissionLogModel(mongoose);
    const now = new Date();
    const active = await PermissionLog.findOne({
      targetUserId,
      permission: PROMPT_TEMPLATE_PERMISSION,
      status: 'active',
      deletedAt: { $exists: false },
    }).sort({ grantedAt: -1, updatedAt: -1 });

    if (!active) {
      return null;
    }

    active.status = 'revoked';
    active.revokedBy = revokedBy;
    active.revokedByEmail = cleanText(revokedByEmail);
    active.revokedAt = now;
    await active.save();
    return active.toObject();
  }

  async function listImagePromptTemplatePermissionLogs({
    search,
    status = 'all',
    limit = 50,
    offset = 0,
  }: {
    search?: string;
    status?: ImagePromptTemplatePermissionLogStatus | 'all';
    limit?: number;
    offset?: number;
  } = {}) {
    const PermissionLog = getPermissionLogModel(mongoose);
    const query: FilterQuery<IImagePromptTemplatePermissionLogDocument> = {
      permission: PROMPT_TEMPLATE_PERMISSION,
      deletedAt: { $exists: false },
    };
    if (status === 'active' || status === 'revoked') {
      query.status = status;
    }

    const trimmed = cleanText(search);
    if (trimmed) {
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      query.$or = [{ targetUserName: regex }, { targetUserEmail: regex }];
    }

    const [records, total] = await Promise.all([
      PermissionLog.find(query)
        .sort({ updatedAt: -1, grantedAt: -1, _id: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      PermissionLog.countDocuments(query),
    ]);

    return { records, total };
  }

  async function softDeleteRevokedImagePromptTemplatePermissionLog({
    recordId,
    deletedBy,
  }: {
    recordId: string;
    deletedBy: string;
  }) {
    const PermissionLog = getPermissionLogModel(mongoose);
    const record = await PermissionLog.findOne({
      _id: recordId,
      permission: PROMPT_TEMPLATE_PERMISSION,
      deletedAt: { $exists: false },
    });

    if (!record) {
      throw new Error('授权记录不存在');
    }
    if (record.status !== 'revoked') {
      throw new Error('当前有效授权记录不能删除，请先取消授权');
    }

    record.deletedAt = new Date();
    record.deletedBy = deletedBy;
    await record.save();
    return { deleted: true };
  }

  return {
    grantImagePromptTemplatePermissionLog,
    listImagePromptTemplatePermissionLogs,
    revokeImagePromptTemplatePermissionLog,
    softDeleteRevokedImagePromptTemplatePermissionLog,
  };
}

export type ImagePromptTemplatePermissionLogMethods = ReturnType<
  typeof createImagePromptTemplatePermissionLogMethods
>;
