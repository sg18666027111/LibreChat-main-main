/* eslint-disable i18next/no-literal-string */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck,
  Ban,
  BarChart3,
  BellRing,
  FileClock,
  Loader2,
  Mail,
  RefreshCw,
  Save,
  Search,
  Send,
  Shield,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserCog,
  UserX,
  UsersRound,
} from 'lucide-react';
import { getTokenHeader, SystemRoles } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';
import AdminPasswordResetDialog from './AdminPasswordResetDialog';

type TabKey = 'accounts' | 'usage' | 'permissions';
type AccountStatus = 'all' | 'pending' | 'active' | 'suspended' | 'rejected' | 'deleting';
type AdminRole = 'user' | 'admin' | 'super_admin';
type RecordStatusFilter = 'all' | 'active' | 'revoked';

type UsageSummary = {
  eventCount: number;
  costCny: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cachedOutputTokens?: number;
  imageCount: number;
  requestCount?: number;
  textCostCny?: number;
  imageCostCny?: number;
  failedCount?: number;
  statusCounts?: Partial<
    Record<'submitted' | 'succeeded' | 'failed' | 'cancelled' | 'status_unknown', number>
  >;
};

type UsageBusinessType =
  | 'chat'
  | 'vision_analysis'
  | 'image_generation'
  | 'multi_reference_generation'
  | 'product_replacement'
  | 'white_background'
  | 'batch_image_generation'
  | 'canvas_generation'
  | 'main_image_generation'
  | 'detail_page_generation'
  | 'other';

type UsageStatus = 'submitted' | 'succeeded' | 'failed' | 'cancelled' | 'status_unknown';

type AdminAccount = {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
  adminRole: AdminRole;
  provider: string;
  approvalStatus: Exclude<AccountStatus, 'all'>;
  approvalRejectedReason?: string;
  isSuperAdmin?: boolean;
  canManageImagePromptTemplates: boolean;
  usage24h?: UsageSummary;
  createdAt?: string;
  updatedAt?: string;
  lastLoginAt?: string;
};

type PermissionRecord = {
  id: string;
  targetUserId: string;
  targetUserName?: string;
  targetUserEmail?: string;
  permission: string;
  status: 'active' | 'revoked';
  grantedBy?: string;
  grantedByEmail?: string;
  grantedAt?: string;
  revokedBy?: string;
  revokedByEmail?: string;
  revokedAt?: string;
};

type UsageDashboard = {
  hours: number;
  since?: string;
  totals: UsageSummary & {
    userCount: number;
    failedCount: number;
  };
  byUser: Array<
    UsageSummary & {
      reportingSubjectId: string;
      userId?: string;
      name?: string;
      email?: string;
      approvalStatus?: string;
    }
  >;
  byModel: Array<
    UsageSummary & {
      provider: string;
      model: string;
      businessType: UsageBusinessType;
    }
  >;
  byBusiness: Array<
    UsageSummary & {
      businessType: UsageBusinessType;
    }
  >;
  recentEvents?: UsageEventRow[];
};

type UsageEventRow = UsageSummary & {
  usageEventId: string;
  occurredAt: string;
  reportingSubjectId: string;
  userId?: string;
  businessType: UsageBusinessType;
  provider: string;
  model: string;
  status: UsageStatus;
  pricingMissing?: boolean;
};

type UsageReportAnomaly = {
  type: 'seven_window_spike' | 'fixed_amount_threshold' | 'missing_pricing';
  reportingSubjectId?: string;
  userId?: string;
  name?: string;
  email?: string;
  currentCostCny?: number;
  baselineCostCny?: number;
  multiplier?: number;
  thresholdSnapshotCny?: number;
  reason: string;
};

type UsageReport = {
  periodKey: string;
  windowStart: string;
  windowEnd: string;
  status: string;
  totals: UsageDashboard['totals'];
  missingPricingCount: number;
  comparison?: {
    previousWindow?: {
      costCnyDelta: number;
      costCnyPercentChange: number | null;
      hasComparableCostBase: boolean;
      eventCountDelta: number;
      userCountDelta: number;
      perUserCostCnyDelta: number;
    };
    sevenWindowAverage?: {
      windowCount: number;
      costCny: number;
      insufficientHistory: boolean;
    };
  };
  byUser?: UsageDashboard['byUser'];
  byModel?: UsageDashboard['byModel'];
  byBusiness?: UsageDashboard['byBusiness'];
  hourly?: Array<
    UsageSummary & {
      hour: string;
    }
  >;
  anomalies?: UsageReportAnomaly[];
  email?: {
    sentAt?: string;
    error?: string;
  };
};

type UsageReportDelivery = {
  recipientEmail: string;
  recipientEmailNormalized: string;
  status: 'sent' | 'failed' | 'skipped' | 'not_configured';
  attemptCount: number;
  manualResendCount: number;
  lastError?: string;
  lastSentAt?: string;
  lastAttemptAt?: string;
  lastManualResendBy?: string;
};

type UsageReportDetails = {
  report: UsageReport;
  deliveries: UsageReportDelivery[];
  events: UsageEventRow[];
};

type AIModelPrice = {
  _id?: string;
  provider: string;
  model: string;
  businessType?: UsageBusinessType;
  inputPriceCnyPer1K?: number;
  outputPriceCnyPer1K?: number;
  imagePriceCny?: number;
  requestPriceCny?: number;
  active?: boolean;
  effectiveFrom?: string;
};

type UsageReportSettings = {
  enabled?: boolean;
  recipients?: string[];
  thresholdCostCny?: number;
  thresholdTokens?: number;
};

type PriceForm = {
  provider: string;
  model: string;
  businessType: UsageBusinessType;
  inputPriceCnyPerMillion: string;
  outputPriceCnyPerMillion: string;
  requestPriceCny: string;
  imagePriceCny: string;
  active: boolean;
};

function formatDate(value?: string) {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatNumber(value?: number) {
  return new Intl.NumberFormat('zh-CN').format(Math.round(value || 0));
}

function formatCny(value?: number) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

function displayAccountName(account: AdminAccount) {
  return account.name || account.username || account.email || '-';
}

function displayRecordName(record: PermissionRecord) {
  return record.targetUserName || record.targetUserEmail || record.targetUserId || '-';
}

async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const authorization = getTokenHeader();
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.message || data?.error || '操作失败，请稍后重试。');
  }

  return response.json();
}

const statusLabels: Record<Exclude<AccountStatus, 'all'>, string> = {
  pending: '待审批',
  active: '已开通',
  suspended: '已停用',
  rejected: '已拒绝',
  deleting: '删除中',
};

const roleLabels: Record<AdminRole, string> = {
  user: '用户',
  admin: '管理员',
  super_admin: '超级管理员',
};

const businessLabels: Record<UsageBusinessType, string> = {
  chat: '聊天',
  vision_analysis: '图文分析',
  image_generation: '独立生图',
  multi_reference_generation: '多参考图',
  product_replacement: '商品替换',
  white_background: '白底图',
  batch_image_generation: '批量商品图',
  canvas_generation: 'Canvas 生图',
  main_image_generation: '主图模式',
  detail_page_generation: '详情页模式',
  other: '其他',
};

const usageStatusLabels: Record<UsageStatus, string> = {
  submitted: '已提交',
  succeeded: '成功',
  failed: '失败',
  cancelled: '取消',
  status_unknown: '状态未知',
};

const defaultPriceForm: PriceForm = {
  provider: '',
  model: '',
  businessType: 'chat',
  inputPriceCnyPerMillion: '',
  outputPriceCnyPerMillion: '',
  requestPriceCny: '',
  imagePriceCny: '',
  active: true,
};

const statusTones: Record<Exclude<AccountStatus, 'all'>, string> = {
  active: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-200',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  deleting: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-200',
  rejected: 'bg-surface-hover text-text-secondary',
  suspended: 'bg-surface-hover text-text-secondary',
};

function StatusPill({ status }: { status: Exclude<AccountStatus, 'all'> }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-1 text-xs ${statusTones[status]}`}>
      {statusLabels[status]}
    </span>
  );
}

function formatPercent(value: number | null | undefined, hasBase?: boolean) {
  if (!hasBase || value == null) {
    return '无可比基数';
  }
  return `${Number(value).toFixed(2)}%`;
}

function formatBusinessType(value?: UsageBusinessType | string) {
  return businessLabels[value as UsageBusinessType] || value || '-';
}

function formatUsageStatus(value?: UsageStatus | string) {
  return usageStatusLabels[value as UsageStatus] || value || '-';
}

function formatEmailStatus(report: UsageReport) {
  if (report.email?.error) {
    return `失败：${report.email.error}`;
  }
  if (report.email?.sentAt) {
    return '已发送';
  }
  return '未发送';
}

function formatDeliveryStatus(status: UsageReportDelivery['status']) {
  return (
    {
      sent: '成功',
      failed: '失败',
      skipped: '已跳过',
      not_configured: '未配置',
    } satisfies Record<UsageReportDelivery['status'], string>
  )[status];
}

function formatAnomalyType(type: UsageReportAnomaly['type']) {
  return (
    {
      seven_window_spike: '超过7日平均',
      fixed_amount_threshold: '超过固定阈值',
      missing_pricing: '未配置价格',
    } satisfies Record<UsageReportAnomaly['type'], string>
  )[type];
}

function isDeletedUsageSubject(row: { userId?: string; name?: string }) {
  return !row.userId && Boolean(row.name?.startsWith('已删除用户 #'));
}

function perMillionFromPer1K(value?: number) {
  return Number(value || 0) * 1000;
}

function per1KFromMillion(value: string) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

export default function AccountAdmin() {
  const { user } = useAuthContext();
  const [activeTab, setActiveTab] = useState<TabKey>('accounts');
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [records, setRecords] = useState<PermissionRecord[]>([]);
  const [usage, setUsage] = useState<UsageDashboard | null>(null);
  const [reports, setReports] = useState<UsageReport[]>([]);
  const [selectedReport, setSelectedReport] = useState<UsageReport | null>(null);
  const [reportDeliveries, setReportDeliveries] = useState<UsageReportDelivery[]>([]);
  const [reportEvents, setReportEvents] = useState<UsageEventRow[]>([]);
  const [prices, setPrices] = useState<AIModelPrice[]>([]);
  const [reportSettings, setReportSettings] = useState<UsageReportSettings | null>(null);
  const [priceForm, setPriceForm] = useState<PriceForm>(defaultPriceForm);
  const [settingsRecipients, setSettingsRecipients] = useState('');
  const [settingsThreshold, setSettingsThreshold] = useState('');
  const [settingsEnabled, setSettingsEnabled] = useState(false);
  const [accountSearch, setAccountSearch] = useState('');
  const [accountStatus, setAccountStatus] = useState<AccountStatus>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | AdminRole>('all');
  const [recordSearch, setRecordSearch] = useState('');
  const [recordStatus, setRecordStatus] = useState<RecordStatusFilter>('all');
  const [accountTotal, setAccountTotal] = useState(0);
  const [recordTotal, setRecordTotal] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isLoadingAccounts, setLoadingAccounts] = useState(false);
  const [isLoadingRecords, setLoadingRecords] = useState(false);
  const [isLoadingUsage, setLoadingUsage] = useState(false);
  const [updatingId, setUpdatingId] = useState('');
  const [deletingRecordId, setDeletingRecordId] = useState('');
  const [resendingReportKey, setResendingReportKey] = useState('');
  const [deleteDialogAccount, setDeleteDialogAccount] = useState<AdminAccount | null>(null);
  const [deleteEmailConfirmation, setDeleteEmailConfirmation] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [resetAccount, setResetAccount] = useState<AdminAccount | null>(null);

  const accountQuery = useMemo(() => {
    const params = new URLSearchParams({ page: '1', pageSize: '50' });
    if (accountSearch.trim()) {
      params.set('search', accountSearch.trim());
    }
    if (accountStatus !== 'all') {
      params.set('status', accountStatus);
    }
    if (roleFilter !== 'all') {
      params.set('role', roleFilter);
    }
    return params.toString();
  }, [accountSearch, accountStatus, roleFilter]);

  const recordQuery = useMemo(() => {
    const params = new URLSearchParams({ page: '1', pageSize: '50', status: recordStatus });
    if (recordSearch.trim()) {
      params.set('search', recordSearch.trim());
    }
    return params.toString();
  }, [recordSearch, recordStatus]);

  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    setError('');
    try {
      const response = await apiFetch<{ users: AdminAccount[]; total: number }>(
        `/api/admin/accounts?${accountQuery}`,
      );
      setAccounts(response.users ?? []);
      setAccountTotal(response.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : '账号列表加载失败。');
    } finally {
      setLoadingAccounts(false);
    }
  }, [accountQuery]);

  const loadRecords = useCallback(async () => {
    setLoadingRecords(true);
    setError('');
    try {
      const response = await apiFetch<{ records: PermissionRecord[]; total: number }>(
        `/api/admin/prompt-template-permissions?${recordQuery}`,
      );
      setRecords(response.records ?? []);
      setRecordTotal(response.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : '授权记录加载失败。');
    } finally {
      setLoadingRecords(false);
    }
  }, [recordQuery]);

  const loadUsage = useCallback(async () => {
    setLoadingUsage(true);
    setError('');
    try {
      const [dashboard, reportResponse, priceResponse, settingsResponse] = await Promise.all([
        apiFetch<UsageDashboard>('/api/admin/usage/dashboard?hours=24'),
        apiFetch<{ reports: UsageReport[] }>('/api/admin/usage/reports?limit=10'),
        apiFetch<{ prices: AIModelPrice[] }>('/api/admin/usage/prices'),
        apiFetch<{ settings: UsageReportSettings }>('/api/admin/usage/settings'),
      ]);
      const nextReports = reportResponse.reports ?? [];
      const preferredReport =
        nextReports.find((report) => (report.totals?.eventCount || 0) > 0) ?? nextReports[0];
      const preferredPeriodKey = preferredReport?.periodKey;
      const reportDetails = preferredPeriodKey
        ? await apiFetch<UsageReportDetails>(
            `/api/admin/usage/reports/${encodeURIComponent(preferredPeriodKey)}/details`,
          )
        : null;
      setUsage(dashboard);
      setReports(nextReports);
      setSelectedReport(reportDetails?.report ?? preferredReport ?? null);
      setReportDeliveries(reportDetails?.deliveries ?? []);
      setReportEvents(reportDetails?.events ?? []);
      setPrices(priceResponse.prices ?? []);
      setReportSettings(settingsResponse.settings ?? null);
      setSettingsRecipients((settingsResponse.settings?.recipients ?? []).join('\n'));
      setSettingsThreshold(
        settingsResponse.settings?.thresholdCostCny == null
          ? ''
          : String(settingsResponse.settings.thresholdCostCny),
      );
      setSettingsEnabled(Boolean(settingsResponse.settings?.enabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : '用量数据加载失败。');
    } finally {
      setLoadingUsage(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadAccounts(), loadRecords(), loadUsage()]);
  }, [loadAccounts, loadRecords, loadUsage]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const updateApproval = async (account: AdminAccount, approvalStatus: 'active' | 'rejected') => {
    const reason =
      approvalStatus === 'rejected' ? window.prompt('请输入拒绝原因（可选）') || '' : '';
    setUpdatingId(account.id);
    setError('');
    setMessage('');
    try {
      await apiFetch(`/api/admin/accounts/${account.id}/approval`, {
        method: 'PATCH',
        body: JSON.stringify({ approvalStatus, reason }),
      });
      setMessage(approvalStatus === 'active' ? '账号已开通。' : '账号已拒绝。');
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : '账号审核操作失败。');
    } finally {
      setUpdatingId('');
    }
  };

  const updateStatus = async (account: AdminAccount, status: 'active' | 'suspended') => {
    const confirmed = window.confirm(
      status === 'suspended' ? '确认停用该账号？' : '确认恢复该账号？',
    );
    if (!confirmed) {
      return;
    }
    setUpdatingId(account.id);
    setError('');
    setMessage('');
    try {
      await apiFetch(`/api/admin/accounts/${account.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setMessage(status === 'suspended' ? '账号已停用。' : '账号已恢复。');
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : '账号状态更新失败。');
    } finally {
      setUpdatingId('');
    }
  };

  const updateRole = async (account: AdminAccount, adminRole: AdminRole) => {
    const confirmed = window.confirm(`确认将该账号设为${roleLabels[adminRole]}？`);
    if (!confirmed) {
      return;
    }
    setUpdatingId(account.id);
    setError('');
    setMessage('');
    try {
      await apiFetch(`/api/admin/accounts/${account.id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ adminRole }),
      });
      setMessage('账号角色已更新。');
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : '账号角色更新失败。');
    } finally {
      setUpdatingId('');
    }
  };

  const grantPermission = async (account: AdminAccount) => {
    setUpdatingId(account.id);
    setError('');
    setMessage('');
    try {
      await apiFetch(`/api/admin/accounts/${account.id}/prompt-template-permission`, {
        method: 'POST',
      });
      setMessage('已授权提示词模板管理权限。');
      await Promise.all([loadAccounts(), loadRecords()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '授权失败。');
    } finally {
      setUpdatingId('');
    }
  };

  const revokePermission = async (account: AdminAccount) => {
    setUpdatingId(account.id);
    setError('');
    setMessage('');
    try {
      await apiFetch(`/api/admin/accounts/${account.id}/prompt-template-permission`, {
        method: 'DELETE',
      });
      setMessage('已取消提示词模板管理权限。');
      await Promise.all([loadAccounts(), loadRecords()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '取消授权失败。');
    } finally {
      setUpdatingId('');
    }
  };

  const deleteRecord = async (record: PermissionRecord) => {
    setDeletingRecordId(record.id);
    setError('');
    setMessage('');
    try {
      await apiFetch(`/api/admin/prompt-template-permissions/${record.id}`, { method: 'DELETE' });
      setMessage('已隐藏该授权记录。');
      await loadRecords();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除授权记录失败。');
    } finally {
      setDeletingRecordId('');
    }
  };

  const generateReport = async (email = false) => {
    setLoadingUsage(true);
    setError('');
    setMessage('');
    try {
      await apiFetch('/api/admin/usage/reports/generate', {
        method: 'POST',
        body: JSON.stringify({ email, forceEmail: email }),
      });
      setMessage(email ? '日报已生成并提交邮件发送。' : '日报已生成。');
      await loadUsage();
    } catch (err) {
      setError(err instanceof Error ? err.message : '日报生成失败。');
    } finally {
      setLoadingUsage(false);
    }
  };

  const resendReportEmail = async (report: UsageReport) => {
    setResendingReportKey(report.periodKey);
    setError('');
    setMessage('');
    try {
      await apiFetch(
        `/api/admin/usage/reports/${encodeURIComponent(report.periodKey)}/email/resend`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setMessage('日报邮件已手动重发。');
      await loadUsage();
    } catch (err) {
      setError(err instanceof Error ? err.message : '日报邮件重发失败。');
    } finally {
      setResendingReportKey('');
    }
  };

  const retryReportEmail = async (report: UsageReport) => {
    setResendingReportKey(report.periodKey);
    setError('');
    setMessage('');
    try {
      await apiFetch(
        `/api/admin/usage/reports/${encodeURIComponent(report.periodKey)}/email/retry-failed`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setMessage('已补发未成功的日报邮件。');
      await loadUsage();
    } catch (err) {
      setError(err instanceof Error ? err.message : '日报邮件补发失败。');
    } finally {
      setResendingReportKey('');
    }
  };

  const selectUsageReport = async (report: UsageReport) => {
    setLoadingUsage(true);
    setError('');
    setMessage('');
    try {
      const details = await apiFetch<UsageReportDetails>(
        `/api/admin/usage/reports/${encodeURIComponent(report.periodKey)}/details`,
      );
      setSelectedReport(details.report);
      setReportDeliveries(details.deliveries ?? []);
      setReportEvents(details.events ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '日报详情加载失败。');
    } finally {
      setLoadingUsage(false);
    }
  };

  const savePrice = async () => {
    if (!priceForm.provider.trim() || !priceForm.model.trim()) {
      setError('请填写供应商和模型。');
      return;
    }
    setLoadingUsage(true);
    setError('');
    setMessage('');
    try {
      await apiFetch('/api/admin/usage/prices', {
        method: 'PUT',
        body: JSON.stringify({
          provider: priceForm.provider.trim(),
          model: priceForm.model.trim(),
          businessType: priceForm.businessType,
          inputPriceCnyPer1K: per1KFromMillion(priceForm.inputPriceCnyPerMillion),
          outputPriceCnyPer1K: per1KFromMillion(priceForm.outputPriceCnyPerMillion),
          requestPriceCny: Number(priceForm.requestPriceCny || 0),
          imagePriceCny: Number(priceForm.imagePriceCny || 0),
          active: priceForm.active,
        }),
      });
      setMessage('价格配置已保存。');
      setPriceForm(defaultPriceForm);
      await loadUsage();
    } catch (err) {
      setError(err instanceof Error ? err.message : '价格保存失败。');
    } finally {
      setLoadingUsage(false);
    }
  };

  const saveReportSettings = async () => {
    setLoadingUsage(true);
    setError('');
    setMessage('');
    try {
      await apiFetch('/api/admin/usage/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          enabled: settingsEnabled,
          recipients: settingsRecipients
            .split(/[\n,]/)
            .map((item) => item.trim())
            .filter(Boolean),
          thresholdCostCny: settingsThreshold.trim() ? Number(settingsThreshold) : undefined,
        }),
      });
      setMessage('日报设置已保存。');
      await loadUsage();
    } catch (err) {
      setError(err instanceof Error ? err.message : '日报设置保存失败。');
    } finally {
      setLoadingUsage(false);
    }
  };

  const openDeleteDialog = (account: AdminAccount) => {
    setDeleteDialogAccount(account);
    setDeleteEmailConfirmation('');
    setDeletePassword('');
    setError('');
    setMessage('');
  };

  const closeDeleteDialog = () => {
    setDeleteDialogAccount(null);
    setDeleteEmailConfirmation('');
    setDeletePassword('');
  };

  const permanentlyDeleteAccount = async () => {
    if (!deleteDialogAccount) {
      return;
    }
    if (deleteEmailConfirmation !== deleteDialogAccount.email) {
      setError('邮箱确认不匹配。');
      return;
    }
    if (!deletePassword) {
      setError('请输入当前超级管理员密码。');
      return;
    }
    setUpdatingId(deleteDialogAccount.id);
    setError('');
    setMessage('');
    try {
      const response = await apiFetch<{ job?: { status?: string } }>(
        `/api/admin/accounts/${deleteDialogAccount.id}/permanent-delete`,
        {
          method: 'POST',
          body: JSON.stringify({
            emailConfirmation: deleteEmailConfirmation,
            currentPassword: deletePassword,
          }),
        },
      );
      setMessage(
        response.job?.status === 'failed'
          ? '删除任务已创建但有步骤失败，请由超级管理员重试。'
          : '账号彻底删除任务已完成。',
      );
      closeDeleteDialog();
      await Promise.all([loadAccounts(), loadUsage()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '账号彻底删除失败。');
    } finally {
      setUpdatingId('');
    }
  };

  if (user?.role !== SystemRoles.ADMIN) {
    return (
      <div className="h-full overflow-y-auto bg-surface-primary text-text-primary">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-6 lg:px-8">
          <h1 className="text-2xl font-semibold">账号管理</h1>
          <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            无权限访问账号管理。
          </div>
        </div>
      </div>
    );
  }

  const isBusy = isLoadingAccounts || isLoadingRecords || isLoadingUsage;
  const selfAccount = accounts.find(
    (account) => account.id === user?.id || account.email === user?.email,
  );
  const isSuperAdmin = Boolean(
    (user as (typeof user & { isSuperAdmin?: boolean }) | undefined)?.isSuperAdmin ||
      selfAccount?.isSuperAdmin,
  );
  const usageTotals = selectedReport?.totals ?? usage?.totals;
  const usageByUser =
    selectedReport?.byUser && selectedReport.byUser.length > 0
      ? selectedReport.byUser
      : (usage?.byUser ?? []);
  const usageByModel =
    selectedReport?.byModel && selectedReport.byModel.length > 0
      ? selectedReport.byModel
      : (usage?.byModel ?? []);
  const usageByBusiness =
    selectedReport?.byBusiness && selectedReport.byBusiness.length > 0
      ? selectedReport.byBusiness
      : (usage?.byBusiness ?? []);
  const usageEventRows = reportEvents.length > 0 ? reportEvents : (usage?.recentEvents ?? []);
  const anonymousDeletedCount = selectedReport?.byUser?.filter(isDeletedUsageSubject).length ?? 0;
  const hasSelectedReportAnomaly = Boolean(selectedReport?.anomalies?.length);

  return (
    <div className="h-full overflow-y-auto bg-surface-primary text-text-primary">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-light pb-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-surface-active-alt">
              <UsersRound className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold">账号与用量管理</h1>
              <p className="text-sm text-text-secondary">账号审批、停用、角色和 AI 用量报表</p>
            </div>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover disabled:opacity-50"
            onClick={refreshAll}
            disabled={isBusy}
          >
            <RefreshCw className={`h-4 w-4 ${isBusy ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </header>

        {(message || error) && (
          <div
            className={`rounded-md border px-3 py-2 text-sm ${
              error
                ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'
                : 'border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
            }`}
          >
            {error || message}
          </div>
        )}

        <div className="inline-flex w-fit rounded-md border border-border-light bg-surface-primary-alt p-1">
          {[
            ['accounts', UserCog, '账号'] as const,
            ['usage', BarChart3, '用量'] as const,
            ['permissions', ShieldCheck, '提示词权限'] as const,
          ].map(([key, Icon, label]) => (
            <button
              key={key}
              type="button"
              className={`inline-flex items-center gap-2 rounded px-3 py-1.5 text-sm ${
                activeTab === key
                  ? 'bg-surface-active-alt text-text-primary'
                  : 'text-text-secondary'
              }`}
              onClick={() => setActiveTab(key)}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        {activeTab === 'accounts' && (
          <section className="border border-border-light bg-surface-primary-alt p-4">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <label className="relative min-w-[260px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                <input
                  type="search"
                  value={accountSearch}
                  onChange={(event) => setAccountSearch(event.target.value)}
                  placeholder="搜索昵称 / 邮箱"
                  className="w-full rounded-md border border-border-medium bg-surface-primary py-2 pl-9 pr-3 text-sm outline-none focus:border-green-500"
                />
              </label>
              <select
                value={accountStatus}
                onChange={(event) => setAccountStatus(event.target.value as AccountStatus)}
                className="rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
              >
                <option value="all">全部状态</option>
                <option value="pending">待审批</option>
                <option value="active">已开通</option>
                <option value="suspended">已停用</option>
                <option value="rejected">已拒绝</option>
                <option value="deleting">删除中</option>
              </select>
              <select
                value={roleFilter}
                onChange={(event) => setRoleFilter(event.target.value as 'all' | AdminRole)}
                className="rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
              >
                <option value="all">全部角色</option>
                <option value="user">用户</option>
                <option value="admin">管理员</option>
                <option value="super_admin">超级管理员</option>
              </select>
              <div className="text-sm text-text-secondary">共 {accountTotal} 个账号</div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[1180px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border-light text-left text-text-secondary">
                    <th className="py-2 pr-3 font-medium">账号</th>
                    <th className="py-2 pr-3 font-medium">状态</th>
                    <th className="py-2 pr-3 font-medium">角色</th>
                    <th className="py-2 pr-3 font-medium">24h 用量</th>
                    <th className="py-2 pr-3 font-medium">最近登录</th>
                    <th className="py-2 pr-3 font-medium">创建时间</th>
                    <th className="py-2 pr-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => {
                    const isUpdating = updatingId === account.id;
                    const usage24h = account.usage24h;
                    return (
                      <tr key={account.id} className="border-b border-border-light align-top">
                        <td className="py-3 pr-3">
                          <div className="font-medium">{displayAccountName(account)}</div>
                          <div className="text-xs text-text-secondary">{account.email || '-'}</div>
                        </td>
                        <td className="py-3 pr-3">
                          <StatusPill status={account.approvalStatus} />
                        </td>
                        <td className="py-3 pr-3">
                          <select
                            value={account.adminRole}
                            disabled={isUpdating}
                            onChange={(event) =>
                              void updateRole(account, event.target.value as AdminRole)
                            }
                            className="rounded-md border border-border-medium bg-surface-primary px-2 py-1 text-sm"
                          >
                            <option value="user">用户</option>
                            <option value="admin">管理员</option>
                            <option value="super_admin">超级管理员</option>
                          </select>
                        </td>
                        <td className="py-3 pr-3">
                          <div>{formatCny(usage24h?.costCny)}</div>
                          <div className="text-xs text-text-secondary">
                            {formatNumber(
                              (usage24h?.inputTokens || 0) + (usage24h?.outputTokens || 0),
                            )}{' '}
                            tokens · {formatNumber(usage24h?.imageCount)} 图
                          </div>
                        </td>
                        <td className="py-3 pr-3">{formatDate(account.lastLoginAt)}</td>
                        <td className="py-3 pr-3">{formatDate(account.createdAt)}</td>
                        <td className="py-3 pr-3">
                          <div className="flex flex-wrap gap-2">
                            {account.provider === 'local' &&
                              account.approvalStatus !== 'deleting' &&
                              account.id !== user?.id &&
                              account.email !== user?.email &&
                              (isSuperAdmin ||
                                (account.role !== SystemRoles.ADMIN && !account.isSuperAdmin)) && (
                                <button
                                  type="button"
                                  className="rounded-md border border-border-medium px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-50"
                                  disabled={isUpdating}
                                  onClick={() => setResetAccount(account)}
                                >
                                  重置密码
                                </button>
                              )}
                            {account.approvalStatus === 'pending' && (
                              <>
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-1 rounded-md bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700 disabled:opacity-50"
                                  disabled={isUpdating}
                                  onClick={() => void updateApproval(account, 'active')}
                                >
                                  <BadgeCheck className="h-3.5 w-3.5" />
                                  开通
                                </button>
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-1 rounded-md border border-border-medium px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-50"
                                  disabled={isUpdating}
                                  onClick={() => void updateApproval(account, 'rejected')}
                                >
                                  <UserX className="h-3.5 w-3.5" />
                                  拒绝
                                </button>
                              </>
                            )}
                            {account.approvalStatus === 'active' ? (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-md border border-border-medium px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-50"
                                disabled={isUpdating}
                                onClick={() => void updateStatus(account, 'suspended')}
                              >
                                <Ban className="h-3.5 w-3.5" />
                                停用
                              </button>
                            ) : (
                              account.approvalStatus !== 'deleting' && (
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-1 rounded-md border border-border-medium px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-50"
                                  disabled={isUpdating}
                                  onClick={() => void updateStatus(account, 'active')}
                                >
                                  <UserCheck className="h-3.5 w-3.5" />
                                  恢复
                                </button>
                              )
                            )}
                            {account.approvalStatus !== 'deleting' && (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/30"
                                disabled={isUpdating}
                                onClick={() => openDeleteDialog(account)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                彻底删除
                              </button>
                            )}
                            {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!isLoadingAccounts && accounts.length === 0 && (
                    <tr>
                      <td className="py-8 text-center text-text-secondary" colSpan={7}>
                        未找到符合条件的账号
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {resetAccount && (
          <AdminPasswordResetDialog
            key={resetAccount.id}
            account={resetAccount}
            onClose={() => setResetAccount(null)}
          />
        )}
        {deleteDialogAccount && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="permanent-delete-title"
              className="w-full max-w-md rounded-lg border border-border-light bg-surface-primary p-5 shadow-xl"
            >
              <div className="mb-4 flex items-center gap-2">
                <Trash2 className="h-5 w-5 text-red-600" />
                <h2 id="permanent-delete-title" className="text-lg font-semibold">
                  彻底删除账号
                </h2>
              </div>
              <div className="space-y-3">
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950/30">
                  <div className="text-xs text-text-secondary">将被删除的账号</div>
                  <div className="mt-1 font-medium">{displayAccountName(deleteDialogAccount)}</div>
                  <div className="mt-1 break-all text-text-secondary">
                    {deleteDialogAccount.email}
                  </div>
                </div>
                <div>
                  <label
                    htmlFor="delete-target-confirmation"
                    className="mb-1 block text-sm text-text-secondary"
                  >
                    请输入目标账号邮箱以确认
                  </label>
                  <input
                    id="delete-target-confirmation"
                    name="delete-target-confirmation"
                    type="text"
                    value={deleteEmailConfirmation}
                    onChange={(event) => setDeleteEmailConfirmation(event.target.value)}
                    className="w-full rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-red-500"
                    placeholder="逐字输入上方目标邮箱"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label
                    htmlFor="delete-admin-approval-secret"
                    className="mb-1 block text-sm text-text-secondary"
                  >
                    请输入当前超级管理员密码
                  </label>
                  <input
                    id="delete-admin-approval-secret"
                    name="delete-admin-approval-secret"
                    type="password"
                    value={deletePassword}
                    onChange={(event) => setDeletePassword(event.target.value)}
                    className="w-full rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-red-500"
                    autoComplete="new-password"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    data-bwignore="true"
                  />
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
                  onClick={closeDeleteDialog}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
                  disabled={updatingId === deleteDialogAccount.id}
                  onClick={() => void permanentlyDeleteAccount()}
                >
                  {updatingId === deleteDialogAccount.id && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  确认删除
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'usage' && (
          <section className="border border-border-light bg-surface-primary-alt p-4">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5 xl:grid-cols-10">
                <Metric label="调用" value={formatNumber(usageTotals?.eventCount)} />
                <Metric label="用户" value={formatNumber(usageTotals?.userCount)} />
                <Metric
                  label="Tokens"
                  value={formatNumber(
                    (usageTotals?.inputTokens || 0) + (usageTotals?.outputTokens || 0),
                  )}
                />
                <Metric label="图片" value={formatNumber(usageTotals?.imageCount)} />
                <Metric label="预计成本" value={formatCny(usageTotals?.costCny)} />
                <Metric label="文本成本" value={formatCny(usageTotals?.textCostCny)} />
                <Metric label="生图成本" value={formatCny(usageTotals?.imageCostCny)} />
                <Metric label="未配置" value={formatNumber(selectedReport?.missingPricingCount)} />
                <Metric label="匿名主体" value={formatNumber(anonymousDeletedCount)} />
                <Metric
                  label="未知/取消"
                  value={`${formatNumber(usageTotals?.statusCounts?.status_unknown)} / ${formatNumber(
                    usageTotals?.statusCounts?.cancelled,
                  )}`}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover disabled:opacity-50"
                  onClick={() => void generateReport(false)}
                  disabled={isLoadingUsage || !isSuperAdmin}
                >
                  <FileClock className="h-4 w-4" />
                  生成日报
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover disabled:opacity-50"
                  onClick={() => void generateReport(true)}
                  disabled={isLoadingUsage || !isSuperAdmin}
                >
                  <Send className="h-4 w-4" />
                  生成并发送
                </button>
              </div>
            </div>
            {selectedReport && (
              <div className="mb-4 text-sm text-text-secondary">
                统计窗口：{new Date(selectedReport.windowStart).toISOString()} 至{' '}
                {new Date(selectedReport.windowEnd).toISOString()} · Asia/Shanghai
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-2">
              <UsageTable
                title="用户排行"
                rows={usageByUser}
                columns={['账号', '事件', 'Tokens', '图片', '成本']}
                renderRow={(row) => [
                  row.name || row.email || row.reportingSubjectId,
                  formatNumber(row.eventCount),
                  formatNumber((row.inputTokens || 0) + (row.outputTokens || 0)),
                  formatNumber(row.imageCount),
                  formatCny(row.costCny),
                ]}
              />
              <UsageTable
                title="模型排行"
                rows={usageByModel}
                columns={['模型', '业务', '事件', '图片', '成本']}
                renderRow={(row) => [
                  `${row.provider}/${row.model}`,
                  formatBusinessType(row.businessType),
                  formatNumber(row.eventCount),
                  formatNumber(row.imageCount),
                  formatCny(row.costCny),
                ]}
              />
              <UsageTable
                title="业务消耗"
                rows={usageByBusiness}
                columns={['业务', '事件', 'Tokens', '图片', '成本']}
                renderRow={(row) => [
                  formatBusinessType(row.businessType),
                  formatNumber(row.eventCount),
                  formatNumber((row.inputTokens || 0) + (row.outputTokens || 0)),
                  formatNumber(row.imageCount),
                  formatCny(row.costCny),
                ]}
              />
              <UsageTable
                title="按小时分布"
                rows={selectedReport?.hourly ?? []}
                columns={['小时', '事件', 'Tokens', '图片', '成本']}
                renderRow={(row) => [
                  row.hour,
                  formatNumber(row.eventCount),
                  formatNumber((row.inputTokens || 0) + (row.outputTokens || 0)),
                  formatNumber(row.imageCount),
                  formatCny(row.costCny),
                ]}
              />
              <UsageTable
                title="最近流水"
                rows={usageEventRows}
                columns={['时间', '模型', '业务', '状态', '成本', '定价']}
                renderRow={(row) => [
                  formatDate(row.occurredAt),
                  `${row.provider}/${row.model}`,
                  formatBusinessType(row.businessType),
                  formatUsageStatus(row.status),
                  formatCny(row.costCny),
                  row.pricingMissing ? '未配置价格' : '已计价',
                ]}
              />
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <UsageTable
                title="异常列表"
                rows={selectedReport?.anomalies ?? []}
                columns={['类型', '账号', '当前', '基准/阈值', '说明']}
                renderRow={(row) => [
                  formatAnomalyType(row.type),
                  row.name || row.email || row.reportingSubjectId || '-',
                  formatCny(row.currentCostCny),
                  row.type === 'fixed_amount_threshold'
                    ? formatCny(row.thresholdSnapshotCny)
                    : formatCny(row.baselineCostCny),
                  row.reason,
                ]}
              />
              <UsageTable
                title="邮件投递"
                rows={reportDeliveries}
                columns={['收件人', '状态', '尝试', '手动重发', '最近错误']}
                renderRow={(row) => [
                  row.recipientEmailNormalized || row.recipientEmail,
                  formatDeliveryStatus(row.status),
                  formatNumber(row.attemptCount),
                  formatNumber(row.manualResendCount),
                  row.lastError || '-',
                ]}
              />
            </div>

            <div className="mt-5 border-t border-border-light pt-5">
              <h2 className="mb-3 text-lg font-semibold">日报记录</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1180px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border-light text-left text-text-secondary">
                      <th className="py-2 pr-3 font-medium">周期</th>
                      <th className="py-2 pr-3 font-medium">窗口</th>
                      <th className="py-2 pr-3 font-medium">调用</th>
                      <th className="py-2 pr-3 font-medium">预计成本</th>
                      <th className="py-2 pr-3 font-medium">前24小时</th>
                      <th className="py-2 pr-3 font-medium">7窗口平均</th>
                      <th className="py-2 pr-3 font-medium">未配置</th>
                      <th className="py-2 pr-3 font-medium">邮件</th>
                      <th className="py-2 pr-3 font-medium">状态</th>
                      <th className="py-2 pr-3 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((report) => (
                      <tr key={report.periodKey} className="border-b border-border-light">
                        <td className="py-3 pr-3">{report.periodKey}</td>
                        <td className="py-3 pr-3">
                          {formatDate(report.windowStart)} - {formatDate(report.windowEnd)}
                        </td>
                        <td className="py-3 pr-3">{formatNumber(report.totals?.eventCount)}</td>
                        <td
                          className={`py-3 pr-3 ${
                            hasSelectedReportAnomaly &&
                            report.periodKey === selectedReport?.periodKey
                              ? 'font-semibold text-red-700 dark:text-red-300'
                              : ''
                          }`}
                        >
                          {formatCny(report.totals?.costCny)}
                        </td>
                        <td className="py-3 pr-3">
                          {formatCny(report.comparison?.previousWindow?.costCnyDelta)} ·{' '}
                          {formatPercent(
                            report.comparison?.previousWindow?.costCnyPercentChange,
                            report.comparison?.previousWindow?.hasComparableCostBase,
                          )}
                        </td>
                        <td className="py-3 pr-3">
                          {report.comparison?.sevenWindowAverage?.insufficientHistory
                            ? '数据不足'
                            : formatCny(report.comparison?.sevenWindowAverage?.costCny)}
                        </td>
                        <td className="py-3 pr-3">
                          {report.missingPricingCount ? (
                            <span className="text-amber-700 dark:text-amber-300">
                              {formatNumber(report.missingPricingCount)}
                            </span>
                          ) : (
                            '0'
                          )}
                        </td>
                        <td className="py-3 pr-3">{formatEmailStatus(report)}</td>
                        <td className="py-3 pr-3">{report.status}</td>
                        <td className="py-3 pr-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="inline-flex items-center gap-2 rounded-md border border-border-medium px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-50"
                              disabled={isLoadingUsage || resendingReportKey === report.periodKey}
                              onClick={() => void selectUsageReport(report)}
                            >
                              查看
                            </button>
                            <button
                              type="button"
                              className="inline-flex items-center gap-2 rounded-md border border-border-medium px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-50"
                              disabled={!isSuperAdmin || resendingReportKey === report.periodKey}
                              onClick={() => void retryReportEmail(report)}
                            >
                              {resendingReportKey === report.periodKey ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Mail className="h-3.5 w-3.5" />
                              )}
                              补发失败
                            </button>
                            <button
                              type="button"
                              className="inline-flex items-center gap-2 rounded-md border border-border-medium px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-50"
                              disabled={!isSuperAdmin || resendingReportKey === report.periodKey}
                              onClick={() => void resendReportEmail(report)}
                            >
                              {resendingReportKey === report.periodKey ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3.5 w-3.5" />
                              )}
                              重发全部
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!reports.length && (
                      <tr>
                        <td className="py-8 text-center text-text-secondary" colSpan={10}>
                          暂无日报
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
              <div className="border-t border-border-light pt-5">
                <h2 className="mb-3 text-lg font-semibold">价格配置</h2>
                <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <input
                    value={priceForm.provider}
                    onChange={(event) =>
                      setPriceForm((current) => ({ ...current, provider: event.target.value }))
                    }
                    placeholder="供应商"
                    className="rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
                    disabled={!isSuperAdmin}
                  />
                  <input
                    value={priceForm.model}
                    onChange={(event) =>
                      setPriceForm((current) => ({ ...current, model: event.target.value }))
                    }
                    placeholder="模型"
                    className="rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
                    disabled={!isSuperAdmin}
                  />
                  <select
                    value={priceForm.businessType}
                    onChange={(event) =>
                      setPriceForm((current) => ({
                        ...current,
                        businessType: event.target.value as UsageBusinessType,
                      }))
                    }
                    className="rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
                    disabled={!isSuperAdmin}
                  >
                    {Object.entries(businessLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <label className="inline-flex items-center gap-2 rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={priceForm.active}
                      onChange={(event) =>
                        setPriceForm((current) => ({ ...current, active: event.target.checked }))
                      }
                      disabled={!isSuperAdmin}
                    />
                    启用
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={priceForm.inputPriceCnyPerMillion}
                    onChange={(event) =>
                      setPriceForm((current) => ({
                        ...current,
                        inputPriceCnyPerMillion: event.target.value,
                      }))
                    }
                    placeholder="每百万输入 Token"
                    className="rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
                    disabled={!isSuperAdmin}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={priceForm.outputPriceCnyPerMillion}
                    onChange={(event) =>
                      setPriceForm((current) => ({
                        ...current,
                        outputPriceCnyPerMillion: event.target.value,
                      }))
                    }
                    placeholder="每百万输出 Token"
                    className="rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
                    disabled={!isSuperAdmin}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={priceForm.requestPriceCny}
                    onChange={(event) =>
                      setPriceForm((current) => ({
                        ...current,
                        requestPriceCny: event.target.value,
                      }))
                    }
                    placeholder="每次请求"
                    className="rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
                    disabled={!isSuperAdmin}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={priceForm.imagePriceCny}
                    onChange={(event) =>
                      setPriceForm((current) => ({ ...current, imagePriceCny: event.target.value }))
                    }
                    placeholder="每张图片"
                    className="rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
                    disabled={!isSuperAdmin}
                  />
                </div>
                {isSuperAdmin && (
                  <button
                    type="button"
                    className="mb-4 inline-flex items-center gap-2 rounded-md bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
                    disabled={isLoadingUsage}
                    onClick={() => void savePrice()}
                  >
                    <Save className="h-4 w-4" />
                    保存价格
                  </button>
                )}
                <UsageTable
                  title="已配置模型"
                  rows={prices}
                  columns={['供应商/模型', '业务', '输入/百万', '输出/百万', '请求', '图片']}
                  renderRow={(row) => [
                    `${row.provider}/${row.model}`,
                    formatBusinessType(row.businessType),
                    formatCny(perMillionFromPer1K(row.inputPriceCnyPer1K)),
                    formatCny(perMillionFromPer1K(row.outputPriceCnyPer1K)),
                    formatCny(row.requestPriceCny),
                    formatCny(row.imagePriceCny),
                  ]}
                />
              </div>

              <div className="border-t border-border-light pt-5">
                <div className="mb-3 flex items-center gap-2">
                  <BellRing className="h-5 w-5 text-text-secondary" />
                  <h2 className="text-lg font-semibold">报表设置</h2>
                </div>
                <label className="mb-3 inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settingsEnabled}
                    onChange={(event) => setSettingsEnabled(event.target.checked)}
                    disabled={!isSuperAdmin}
                  />
                  启用邮件日报
                </label>
                <textarea
                  value={settingsRecipients}
                  onChange={(event) => setSettingsRecipients(event.target.value)}
                  rows={5}
                  placeholder="接收邮箱，每行一个"
                  className="mb-3 w-full rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
                  disabled={!isSuperAdmin}
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={settingsThreshold}
                  onChange={(event) => setSettingsThreshold(event.target.value)}
                  placeholder="固定金额告警阈值 CNY"
                  className="mb-3 w-full rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
                  disabled={!isSuperAdmin}
                />
                <div className="mb-3 text-sm text-text-secondary">
                  当前：{reportSettings?.enabled ? '已启用' : '未启用'} · 收件人{' '}
                  {formatNumber(reportSettings?.recipients?.length)}
                </div>
                {isSuperAdmin && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-md bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
                    disabled={isLoadingUsage}
                    onClick={() => void saveReportSettings()}
                  >
                    <Save className="h-4 w-4" />
                    保存设置
                  </button>
                )}
              </div>
            </div>
          </section>
        )}

        {activeTab === 'permissions' && (
          <section className="border border-border-light bg-surface-primary-alt p-4">
            <div className="mb-4 flex items-start gap-3 border border-border-light bg-surface-primary px-3 py-3">
              <Shield className="mt-0.5 h-5 w-5 text-text-secondary" />
              <div>
                <h2 className="text-sm font-semibold">提示词模板管理</h2>
                <p className="text-sm text-text-secondary">
                  授权账号新增、编辑、恢复和停用批量出图全局提示词模板。
                </p>
              </div>
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-3">
              <label className="relative min-w-[260px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                <input
                  type="search"
                  value={recordSearch}
                  onChange={(event) => setRecordSearch(event.target.value)}
                  placeholder="搜索记录"
                  className="w-full rounded-md border border-border-medium bg-surface-primary py-2 pl-9 pr-3 text-sm outline-none focus:border-green-500"
                />
              </label>
              <select
                value={recordStatus}
                onChange={(event) => setRecordStatus(event.target.value as RecordStatusFilter)}
                className="rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm outline-none focus:border-green-500"
              >
                <option value="all">全部记录</option>
                <option value="active">当前有效</option>
                <option value="revoked">已取消</option>
              </select>
              <div className="text-sm text-text-secondary">共 {recordTotal} 条记录</div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border-light text-left text-text-secondary">
                    <th className="py-2 pr-3 font-medium">账号</th>
                    <th className="py-2 pr-3 font-medium">邮箱</th>
                    <th className="py-2 pr-3 font-medium">状态</th>
                    <th className="py-2 pr-3 font-medium">授权人</th>
                    <th className="py-2 pr-3 font-medium">授权时间</th>
                    <th className="py-2 pr-3 font-medium">取消人</th>
                    <th className="py-2 pr-3 font-medium">取消时间</th>
                    <th className="py-2 pr-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => {
                    const isDeleting = deletingRecordId === record.id;
                    return (
                      <tr key={record.id} className="border-b border-border-light">
                        <td className="py-3 pr-3">{displayRecordName(record)}</td>
                        <td className="py-3 pr-3">{record.targetUserEmail || '-'}</td>
                        <td className="py-3 pr-3">
                          {record.status === 'active' ? '已授权' : '已取消'}
                        </td>
                        <td className="py-3 pr-3">
                          {record.grantedByEmail || record.grantedBy || '-'}
                        </td>
                        <td className="py-3 pr-3">{formatDate(record.grantedAt)}</td>
                        <td className="py-3 pr-3">
                          {record.revokedByEmail || record.revokedBy || '-'}
                        </td>
                        <td className="py-3 pr-3">{formatDate(record.revokedAt)}</td>
                        <td className="py-3 pr-3">
                          {record.status === 'revoked' && (
                            <button
                              type="button"
                              className="inline-flex items-center gap-2 rounded-md border border-border-medium px-3 py-1.5 text-sm hover:bg-surface-hover disabled:opacity-50"
                              disabled={isDeleting}
                              onClick={() => void deleteRecord(record)}
                            >
                              {isDeleting ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                              删除记录
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[860px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border-light text-left text-text-secondary">
                    <th className="py-2 pr-3 font-medium">账号</th>
                    <th className="py-2 pr-3 font-medium">邮箱</th>
                    <th className="py-2 pr-3 font-medium">权限</th>
                    <th className="py-2 pr-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => {
                    const isUpdating = updatingId === account.id;
                    const isAdminAccount = account.role === SystemRoles.ADMIN;
                    let permissionLabel = '未授权';
                    if (isAdminAccount) {
                      permissionLabel = '管理员默认拥有';
                    } else if (account.canManageImagePromptTemplates) {
                      permissionLabel = '已授权';
                    }

                    return (
                      <tr key={account.id} className="border-b border-border-light">
                        <td className="py-3 pr-3">{displayAccountName(account)}</td>
                        <td className="py-3 pr-3">{account.email || '-'}</td>
                        <td className="py-3 pr-3">{permissionLabel}</td>
                        <td className="py-3 pr-3">
                          {!isAdminAccount &&
                            (account.canManageImagePromptTemplates ? (
                              <button
                                type="button"
                                className="inline-flex items-center gap-2 rounded-md border border-border-medium px-3 py-1.5 text-sm hover:bg-surface-hover disabled:opacity-50"
                                disabled={isUpdating}
                                onClick={() => void revokePermission(account)}
                              >
                                <UserX className="h-4 w-4" />
                                取消授权
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="inline-flex items-center gap-2 rounded-md bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700 disabled:opacity-50"
                                disabled={isUpdating}
                                onClick={() => void grantPermission(account)}
                              >
                                <UserCheck className="h-4 w-4" />
                                授权
                              </button>
                            ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border-light bg-surface-primary px-3 py-2">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function UsageTable<T>({
  title,
  rows,
  columns,
  renderRow,
}: {
  title: string;
  rows: T[];
  columns: string[];
  renderRow: (row: T) => string[];
}) {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border-light text-left text-text-secondary">
              {columns.map((column) => (
                <th key={column} className="py-2 pr-3 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-b border-border-light">
                {renderRow(row).map((value, cellIndex) => (
                  <td key={cellIndex} className="py-3 pr-3">
                    {value}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="py-8 text-center text-text-secondary" colSpan={columns.length}>
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
