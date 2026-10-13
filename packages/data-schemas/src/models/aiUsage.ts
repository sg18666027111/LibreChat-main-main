import {
  adminAuditLogSchema,
  aiModelPriceSchema,
  aiUsageEventSchema,
  usageReportDeliverySchema,
  usageReportSchema,
  usageReportSettingsSchema,
} from '~/schema/aiUsage';
import type {
  IAdminAuditLog,
  IAIModelPrice,
  IAIUsageEvent,
  IUsageReport,
  IUsageReportDelivery,
  IUsageReportSettings,
} from '~/types/aiUsage';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

export function createAIUsageEventModel(mongoose: typeof import('mongoose')) {
  applyTenantIsolation(aiUsageEventSchema);
  return (
    mongoose.models.AIUsageEvent ||
    mongoose.model<IAIUsageEvent>('AIUsageEvent', aiUsageEventSchema)
  );
}

export function createAIModelPriceModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.AIModelPrice ||
    mongoose.model<IAIModelPrice>('AIModelPrice', aiModelPriceSchema)
  );
}

export function createUsageReportModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.UsageReport || mongoose.model<IUsageReport>('UsageReport', usageReportSchema)
  );
}

export function createUsageReportDeliveryModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.UsageReportDelivery ||
    mongoose.model<IUsageReportDelivery>('UsageReportDelivery', usageReportDeliverySchema)
  );
}

export function createUsageReportSettingsModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.UsageReportSettings ||
    mongoose.model<IUsageReportSettings>('UsageReportSettings', usageReportSettingsSchema)
  );
}

export function createAdminAuditLogModel(mongoose: typeof import('mongoose')) {
  applyTenantIsolation(adminAuditLogSchema);
  return (
    mongoose.models.AdminAuditLog ||
    mongoose.model<IAdminAuditLog>('AdminAuditLog', adminAuditLogSchema)
  );
}
