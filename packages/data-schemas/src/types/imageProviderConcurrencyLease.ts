import type { HydratedDocument } from 'mongoose';

export interface IImageProviderConcurrencyLease {
  _id: string;
  resourceKey: string;
  slot: number;
  ownerId: string;
  internalTaskId: string;
  providerTaskId?: string;
  leaseExpiresAt: Date;
  heartbeatAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type IImageProviderConcurrencyLeaseDocument =
  HydratedDocument<IImageProviderConcurrencyLease>;
