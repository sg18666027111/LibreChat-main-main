const crypto = require('crypto');
const mongoose = require('mongoose');

const INVITE_CODE_STATUSES = {
  ACTIVE: 'active',
  DISABLED: 'disabled',
  USED_UP: 'used_up',
};

const APPROVAL_STATUSES = {
  PENDING: 'pending',
  ACTIVE: 'active',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended',
  DELETING: 'deleting',
  DISABLED: 'disabled',
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const inviteCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: Object.values(INVITE_CODE_STATUSES),
      default: INVITE_CODE_STATUSES.ACTIVE,
      index: true,
    },
    maxUses: { type: Number, default: 1, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
  },
  { timestamps: true, collection: 'invitecodes' },
);

const InviteCode = mongoose.models.InviteCode || mongoose.model('InviteCode', inviteCodeSchema);

function normalizeInviteCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase();
}

function randomCodePart(length) {
  let value = '';
  for (let i = 0; i < length; i += 1) {
    value += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return value;
}

function generateInviteCodeString() {
  return `JJC-${randomCodePart(4)}-${randomCodePart(4)}`;
}

function getUsableInviteQuery(code) {
  const now = new Date();
  return {
    code: normalizeInviteCode(code),
    status: INVITE_CODE_STATUSES.ACTIVE,
    $expr: { $lt: ['$usedCount', '$maxUses'] },
    $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
  };
}

function toPlainInvite(inviteCode) {
  if (!inviteCode) {
    return null;
  }
  const item = typeof inviteCode.toObject === 'function' ? inviteCode.toObject() : inviteCode;
  return {
    _id: item._id?.toString?.() ?? item._id,
    code: item.code,
    status: item.status,
    maxUses: item.maxUses,
    usedCount: item.usedCount,
    expiresAt: item.expiresAt,
    note: item.note || '',
    createdBy: item.createdBy?.toString?.() ?? item.createdBy ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function listInviteCodes() {
  const items = await InviteCode.find({}).sort({ createdAt: -1 }).limit(200).lean();
  return items.map(toPlainInvite);
}

async function createInviteCodes({
  count = 1,
  maxUses = 1,
  expiresAt = null,
  note = '',
  createdBy,
}) {
  const safeCount = Math.min(Math.max(Number.parseInt(count, 10) || 1, 1), 100);
  const safeMaxUses = Math.min(Math.max(Number.parseInt(maxUses, 10) || 1, 1), 1000);
  const docs = [];

  for (let i = 0; i < safeCount; i += 1) {
    let code = generateInviteCodeString();
    let attempts = 0;
    while (await InviteCode.exists({ code })) {
      attempts += 1;
      if (attempts > 10) {
        throw new Error('邀请码生成失败，请重试。');
      }
      code = generateInviteCodeString();
    }

    docs.push({
      code,
      maxUses: safeMaxUses,
      usedCount: 0,
      status: INVITE_CODE_STATUSES.ACTIVE,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      note: String(note || '')
        .trim()
        .slice(0, 200),
      createdBy: createdBy || null,
    });
  }

  const created = await InviteCode.insertMany(docs);
  return created.map(toPlainInvite);
}

async function validateInviteCode(code) {
  const normalizedCode = normalizeInviteCode(code);
  if (!normalizedCode) {
    return { ok: false, message: '邀请码无效，请联系管理员获取邀请码' };
  }

  const inviteCode = await InviteCode.findOne(getUsableInviteQuery(normalizedCode)).lean();
  if (!inviteCode) {
    return { ok: false, message: '邀请码无效，请联系管理员获取邀请码' };
  }

  return { ok: true, inviteCode: toPlainInvite(inviteCode) };
}

async function consumeInviteCode(code) {
  const normalizedCode = normalizeInviteCode(code);
  const updated = await InviteCode.findOneAndUpdate(
    getUsableInviteQuery(normalizedCode),
    [
      { $set: { usedCount: { $add: ['$usedCount', 1] }, updatedAt: '$$NOW' } },
      {
        $set: {
          status: {
            $cond: [
              { $gte: ['$usedCount', '$maxUses'] },
              INVITE_CODE_STATUSES.USED_UP,
              INVITE_CODE_STATUSES.ACTIVE,
            ],
          },
        },
      },
    ],
    { new: true },
  );

  if (!updated) {
    return { ok: false, message: '邀请码无效，请联系管理员获取邀请码' };
  }

  return { ok: true, inviteCode: toPlainInvite(updated) };
}

/** Compensates a failed registration without re-enabling a code disabled by an admin. */
async function releaseInviteCodeUse(id) {
  await InviteCode.updateOne({ _id: id, usedCount: { $gt: 0 } }, [
    {
      $set: {
        usedCount: { $subtract: ['$usedCount', 1] },
        status: {
          $cond: [
            { $eq: ['$status', INVITE_CODE_STATUSES.USED_UP] },
            INVITE_CODE_STATUSES.ACTIVE,
            '$status',
          ],
        },
        updatedAt: '$$NOW',
      },
    },
  ]);
}

async function disableInviteCode(id) {
  const updated = await InviteCode.findByIdAndUpdate(
    id,
    { $set: { status: INVITE_CODE_STATUSES.DISABLED } },
    { new: true },
  ).lean();
  return toPlainInvite(updated);
}

async function deleteInviteCode(id) {
  const result = await InviteCode.deleteOne({ _id: id });
  return { deletedCount: result.deletedCount };
}

function usersCollection() {
  return mongoose.connection.collection('users');
}

async function setUserApprovalStatus(userId, approvalStatus) {
  const _id = new mongoose.Types.ObjectId(String(userId));
  const normalizedStatus =
    approvalStatus === APPROVAL_STATUSES.DISABLED ? APPROVAL_STATUSES.SUSPENDED : approvalStatus;
  const result = await usersCollection().findOneAndUpdate(
    { _id },
    {
      $set: {
        approvalStatus: normalizedStatus,
        accountStatusUpdatedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  return result?.value ?? result;
}

async function getUserApprovalStatus(userId) {
  if (!userId) {
    return null;
  }
  const _id = new mongoose.Types.ObjectId(String(userId));
  const user = await usersCollection().findOne(
    { _id },
    { projection: { approvalStatus: 1, role: 1, email: 1 } },
  );
  return user?.approvalStatus === APPROVAL_STATUSES.DISABLED
    ? APPROVAL_STATUSES.SUSPENDED
    : user?.approvalStatus || APPROVAL_STATUSES.ACTIVE;
}

async function listUsersByApprovalStatus(status = APPROVAL_STATUSES.PENDING) {
  const users = await usersCollection()
    .find(
      { approvalStatus: status },
      {
        projection: {
          email: 1,
          name: 1,
          username: 1,
          role: 1,
          approvalStatus: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    )
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();

  return users.map((user) => ({
    ...user,
    _id: user._id?.toString?.() ?? user._id,
  }));
}

module.exports = {
  APPROVAL_STATUSES,
  INVITE_CODE_STATUSES,
  createInviteCodes,
  consumeInviteCode,
  releaseInviteCodeUse,
  deleteInviteCode,
  disableInviteCode,
  getUserApprovalStatus,
  listInviteCodes,
  listUsersByApprovalStatus,
  normalizeInviteCode,
  setUserApprovalStatus,
  validateInviteCode,
};
