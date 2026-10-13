import {
  adminMutationLockSchema,
  emailBlocklistSchema,
  userDeletionJobSchema,
} from '~/schema/adminAccount';
import type { IAdminMutationLock, IEmailBlocklist, IUserDeletionJob } from '~/types/adminAccount';

export function createUserDeletionJobModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.UserDeletionJob ||
    mongoose.model<IUserDeletionJob>('UserDeletionJob', userDeletionJobSchema)
  );
}

export function createEmailBlocklistModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.EmailBlocklist ||
    mongoose.model<IEmailBlocklist>('EmailBlocklist', emailBlocklistSchema)
  );
}

export function createAdminMutationLockModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.AdminMutationLock ||
    mongoose.model<IAdminMutationLock>('AdminMutationLock', adminMutationLockSchema)
  );
}
