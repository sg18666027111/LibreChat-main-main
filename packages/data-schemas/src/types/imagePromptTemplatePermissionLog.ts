import type { Document, Types } from 'mongoose';

export type ImagePromptTemplatePermission = 'imagePromptTemplates.manage';

export type ImagePromptTemplatePermissionLogStatus = 'active' | 'revoked';

export interface IImagePromptTemplatePermissionLog {
  _id: Types.ObjectId;
  targetUserId: string;
  targetUserEmail?: string;
  targetUserName?: string;
  permission: ImagePromptTemplatePermission;
  status: ImagePromptTemplatePermissionLogStatus;
  grantedBy: string;
  grantedByEmail?: string;
  grantedAt: Date;
  revokedBy?: string;
  revokedByEmail?: string;
  revokedAt?: Date;
  deletedAt?: Date;
  deletedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type IImagePromptTemplatePermissionLogDocument = IImagePromptTemplatePermissionLog &
  Document;

export type CreateImagePromptTemplatePermissionLogInput = Pick<
  IImagePromptTemplatePermissionLog,
  | 'targetUserId'
  | 'targetUserEmail'
  | 'targetUserName'
  | 'permission'
  | 'status'
  | 'grantedBy'
  | 'grantedByEmail'
  | 'grantedAt'
> &
  Partial<
    Pick<
      IImagePromptTemplatePermissionLog,
      'revokedBy' | 'revokedByEmail' | 'revokedAt' | 'deletedAt' | 'deletedBy'
    >
  >;
