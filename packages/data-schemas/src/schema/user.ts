import { randomUUID } from 'crypto';
import { Schema } from 'mongoose';
import { SystemRoles } from 'librechat-data-provider';
import { IUser } from '~/types';

export const accountApprovalStatuses = [
  'pending',
  'active',
  'suspended',
  'rejected',
  'deleting',
] as const;

export function createReportingSubjectId() {
  return `usr_${randomUUID().replace(/-/g, '')}`;
}

// Session sub-schema
const SessionSchema = new Schema(
  {
    refreshToken: {
      type: String,
      default: '',
    },
  },
  { _id: false },
);

// Backup code sub-schema
const BackupCodeSchema = new Schema(
  {
    codeHash: { type: String, required: true },
    used: { type: Boolean, default: false },
    usedAt: { type: Date, default: null },
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
    },
    username: {
      type: String,
      lowercase: true,
      default: '',
    },
    email: {
      type: String,
      required: [true, "can't be blank"],
      lowercase: true,
      match: [/\S+@\S+\.\S+/, 'is invalid'],
      index: true,
    },
    emailVerified: {
      type: Boolean,
      required: true,
      default: false,
    },
    password: {
      type: String,
      trim: true,
      minlength: 8,
      maxlength: 128,
      select: false,
    },
    avatar: {
      type: String,
      required: false,
    },
    provider: {
      type: String,
      required: true,
      default: 'local',
    },
    role: {
      type: String,
      default: SystemRoles.USER,
    },
    isSuperAdmin: {
      type: Boolean,
      default: false,
      index: true,
    },
    approvalStatus: {
      type: String,
      enum: accountApprovalStatuses,
      default: 'active',
      index: true,
    },
    approvalRejectedReason: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    accountStatusUpdatedAt: {
      type: Date,
      default: Date.now,
    },
    accountStatusUpdatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    sessionVersion: {
      type: Number,
      default: 0,
      min: 0,
    },
    reportingSubjectId: {
      type: String,
      default: createReportingSubjectId,
      index: true,
      immutable: true,
    },
    lastLoginAt: {
      type: Date,
    },
    googleId: {
      type: String,
    },
    facebookId: {
      type: String,
    },
    openidId: {
      type: String,
    },
    openidIssuer: {
      type: String,
    },
    samlId: {
      type: String,
    },
    ldapId: {
      type: String,
    },
    githubId: {
      type: String,
    },
    discordId: {
      type: String,
    },
    appleId: {
      type: String,
    },
    plugins: {
      type: Array,
    },
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    totpSecret: {
      type: String,
      select: false,
    },
    backupCodes: {
      type: [BackupCodeSchema],
      select: false,
    },
    pendingTotpSecret: {
      type: String,
      select: false,
    },
    pendingBackupCodes: {
      type: [BackupCodeSchema],
      select: false,
      default: undefined,
    },
    refreshToken: {
      type: [SessionSchema],
    },
    expiresAt: {
      type: Date,
      expires: 604800, // 7 days in seconds
    },
    termsAccepted: {
      type: Boolean,
      default: false,
    },
    personalization: {
      type: {
        memories: {
          type: Boolean,
          default: true,
        },
      },
      default: {},
    },
    permissions: {
      type: {
        imagePromptTemplates: {
          type: {
            manage: {
              type: Boolean,
              default: false,
            },
          },
          default: {},
        },
      },
      default: {},
    },
    favorites: {
      type: [
        {
          _id: false,
          agentId: { type: String, maxlength: 256 },
          model: { type: String, maxlength: 256 },
          endpoint: { type: String, maxlength: 256 },
          spec: { type: String, maxlength: 256 },
        },
      ],
      default: [],
    },
    skillStates: {
      type: Map,
      of: Boolean,
      default: () => new Map(),
    },
    /** Field for external source identification (for consistency with TPrincipal schema) */
    idOnTheSource: {
      type: String,
      sparse: true,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

userSchema.index({ email: 1, tenantId: 1 }, { unique: true });
userSchema.index({ role: 1, tenantId: 1 });
userSchema.index({ approvalStatus: 1, tenantId: 1 });
userSchema.index({ reportingSubjectId: 1, tenantId: 1 }, { unique: true, sparse: true });
userSchema.index({ idOnTheSource: 1, openidIssuer: 1, tenantId: 1 });

const oAuthIdFields = [
  'googleId',
  'facebookId',
  'openidId',
  'samlId',
  'ldapId',
  'githubId',
  'discordId',
  'appleId',
] as const;

for (const field of oAuthIdFields) {
  if (field === 'openidId') {
    userSchema.index(
      { openidId: 1, openidIssuer: 1, tenantId: 1 },
      { unique: true, partialFilterExpression: { openidId: { $exists: true } } },
    );
    continue;
  }

  userSchema.index(
    { [field]: 1, tenantId: 1 },
    { unique: true, partialFilterExpression: { [field]: { $exists: true } } },
  );
}

export default userSchema;
