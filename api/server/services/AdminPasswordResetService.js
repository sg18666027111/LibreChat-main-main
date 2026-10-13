const { randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { findUser, deleteTokens } = require('~/models');
const { passwordResetEnabled } = require('~/server/utils/authConfig');
const {
  assertCanManageAccount,
  getLoginBlock,
  getUserId,
  withAdminMutationLock,
} = require('~/server/services/AccountStateService');

const failure = (status, message) => Object.assign(new Error(message), { status });

/** Only called behind JWT + ACCESS_ADMIN + MANAGE_USERS authorization. */
async function createAdminPasswordReset({ actor, targetUserId }) {
  if (!passwordResetEnabled()) {
    throw failure(403, '密码重置功能未开启');
  }
  const actorId = getUserId(actor);
  if (!mongoose.isObjectIdOrHexString(actorId)) {
    throw failure(403, '需要管理员权限');
  }
  if (!mongoose.isObjectIdOrHexString(targetUserId)) {
    throw failure(400, '用户 ID 格式不正确');
  }
  targetUserId = String(targetUserId).toLowerCase();
  return withAdminMutationLock(`password-reset:${targetUserId}`, async () => {
    const projection =
      '_id email role isSuperAdmin provider approvalStatus tenantId sessionVersion';
    const currentActor = await findUser({ _id: actorId }, projection);
    if (!currentActor || getLoginBlock(currentActor)) {
      throw failure(403, '需要有效的管理员账号');
    }
    const target = await findUser({ _id: targetUserId }, projection);
    if (!target) {
      throw failure(404, '用户不存在');
    }
    if ((currentActor.tenantId || '') !== (target.tenantId || '')) {
      throw failure(403, '不能管理其他租户的账号');
    }
    assertCanManageAccount(currentActor, target);
    if (target.provider !== 'local' || target.approvalStatus === 'deleting') {
      throw failure(400, '此账号不支持本地密码重置');
    }

    // Use only the configured site URL, never an untrusted request Host/Origin.
    const baseUrl = new URL(process.env.DOMAIN_CLIENT);
    const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname);
    if (
      (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && localDevelopment)) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw failure(503, '请先配置正确的站点地址');
    }
    const token = randomBytes(32).toString('hex');
    const hash = bcrypt.hashSync(token, 10);
    const query = { userId: target._id, type: 'password_reset' };
    const identifier = JSON.stringify({
      sessionVersion: target.sessionVersion ?? 0,
      role: target.role,
      isSuperAdmin: target.isSuperAdmin === true,
      tenantId: target.tenantId || '',
    });
    const createdAt = new Date();
    // Reserve the user's ObjectId as the reset-record key in the existing Token collection.
    // Mongo's _id uniqueness makes replacement atomic even if a mutation lease expires.
    // Including purpose/user in the filter fails closed on an unexpected key collision.
    let stored;
    try {
      stored = await mongoose.models.Token.findOneAndUpdate(
        {
          _id: target._id,
          ...query,
          $or: [
            { 'metadata.resetSessionVersion': { $lte: target.sessionVersion ?? 0 } },
            { 'metadata.resetSessionVersion': { $exists: false } },
          ],
        },
        {
          $set: {
            ...query,
            token: hash,
            identifier,
            'metadata.resetSessionVersion': target.sessionVersion ?? 0,
            createdAt,
            expiresAt: new Date(createdAt.getTime() + 900000),
          },
        },
        { upsert: true, new: true, runValidators: true },
      );
    } catch (error) {
      // A stalled issuance must not overwrite a link issued after a password change.
      if (error?.code === 11000) {
        throw failure(409, '账号状态已变化，请重新生成重置链接');
      }
      throw error;
    }
    try {
      // Fail closed if auditing fails. Never persist the raw token or URL in the audit trail.
      await mongoose.models.AdminAuditLog.create({
        tenantId: currentActor.tenantId,
        actorId: currentActor._id,
        actorEmail: currentActor.email,
        targetUserId: target._id,
        targetEmail: target.email,
        action: 'password_reset_link_created',
        metadata: { expiresAt: stored.expiresAt },
      });
    } catch {
      await deleteTokens({ ...query, token: hash });
      throw failure(503, '操作记录保存失败，请稍后重试');
    }
    const link = new URL(`${baseUrl.toString().replace(/\/$/, '')}/reset-password`);
    link.searchParams.set('token', token);
    link.searchParams.set('userId', String(target._id));
    return { link: link.toString(), expiresAt: stored.expiresAt };
  });
}

module.exports = { createAdminPasswordReset };
