import { Schema } from 'mongoose';
import type { IImagePromptTemplatePermissionLogDocument } from '~/types/imagePromptTemplatePermissionLog';

const imagePromptTemplatePermissionLogSchema: Schema<IImagePromptTemplatePermissionLogDocument> =
  new Schema(
    {
      targetUserId: {
        type: String,
        required: true,
        trim: true,
        index: true,
      },
      targetUserEmail: {
        type: String,
        trim: true,
        lowercase: true,
        default: '',
        index: true,
      },
      targetUserName: {
        type: String,
        trim: true,
        default: '',
        index: true,
      },
      permission: {
        type: String,
        enum: ['imagePromptTemplates.manage'],
        required: true,
        index: true,
      },
      status: {
        type: String,
        enum: ['active', 'revoked'],
        required: true,
        index: true,
      },
      grantedBy: {
        type: String,
        required: true,
        trim: true,
      },
      grantedByEmail: {
        type: String,
        trim: true,
        lowercase: true,
        default: '',
      },
      grantedAt: {
        type: Date,
        required: true,
      },
      revokedBy: {
        type: String,
        trim: true,
        default: '',
      },
      revokedByEmail: {
        type: String,
        trim: true,
        lowercase: true,
        default: '',
      },
      revokedAt: {
        type: Date,
      },
      deletedAt: {
        type: Date,
        index: true,
      },
      deletedBy: {
        type: String,
        trim: true,
        default: '',
      },
    },
    {
      timestamps: true,
    },
  );

imagePromptTemplatePermissionLogSchema.index({
  targetUserId: 1,
  permission: 1,
  status: 1,
  deletedAt: 1,
});
imagePromptTemplatePermissionLogSchema.index({ status: 1, grantedAt: -1 });
imagePromptTemplatePermissionLogSchema.index({ targetUserEmail: 1, targetUserName: 1 });

export default imagePromptTemplatePermissionLogSchema;
