import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Copy, KeyRound, Loader2, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { getTokenHeader } from 'librechat-data-provider';

type InviteCodeStatus = 'active' | 'disabled' | 'used_up';
type ApprovalStatus = 'pending' | 'active' | 'rejected' | 'disabled';

type InviteCode = {
  _id: string;
  code: string;
  status: InviteCodeStatus;
  maxUses: number;
  usedCount: number;
  expiresAt?: string | null;
  note?: string;
  createdAt?: string;
};

type PendingUser = {
  _id: string;
  email: string;
  name?: string;
  username?: string;
  role?: string;
  approvalStatus?: ApprovalStatus;
  createdAt?: string;
};

const statusText: Record<InviteCodeStatus, string> = {
  active: '可用',
  disabled: '已停用',
  used_up: '已用满',
};

function formatDate(value?: string | null) {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
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
    throw new Error(data?.message || '操作失败，请稍后重试。');
  }

  return response.json();
}

export default function InviteCodeAdmin() {
  const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [count, setCount] = useState(1);
  const [maxUses, setMaxUses] = useState(1);
  const [expiresAt, setExpiresAt] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const activeInviteCount = useMemo(
    () => inviteCodes.filter((item) => item.status === 'active').length,
    [inviteCodes],
  );

  const loadData = async () => {
    setIsLoading(true);
    setError('');
    try {
      const [inviteResponse, usersResponse] = await Promise.all([
        apiFetch<{ inviteCodes: InviteCode[] }>('/api/admin/invite-codes'),
        apiFetch<{ users: PendingUser[] }>('/api/admin/invite-codes/users/pending'),
      ]);
      setInviteCodes(inviteResponse.inviteCodes);
      setPendingUsers(usersResponse.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败，请稍后重试。');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage('已复制邀请码');
    } catch {
      setError('复制失败，请手动选择内容复制。');
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError('');
    setMessage('');
    try {
      const response = await apiFetch<{ inviteCodes: InviteCode[] }>('/api/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({
          count,
          maxUses,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          note,
        }),
      });
      setInviteCodes((current) => [...response.inviteCodes, ...current]);
      setMessage(`已生成 ${response.inviteCodes.length} 个邀请码`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败，请稍后重试。');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDisable = async (id: string) => {
    try {
      const response = await apiFetch<{ inviteCode: InviteCode }>(
        `/api/admin/invite-codes/${id}/disable`,
        { method: 'PATCH', body: JSON.stringify({}) },
      );
      setInviteCodes((current) =>
        current.map((item) => (item._id === id ? response.inviteCode : item)),
      );
      setMessage('邀请码已停用');
    } catch (err) {
      setError(err instanceof Error ? err.message : '停用失败，请稍后重试。');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/api/admin/invite-codes/${id}`, { method: 'DELETE' });
      setInviteCodes((current) => current.filter((item) => item._id !== id));
      setMessage('邀请码已删除');
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败，请稍后重试。');
    }
  };

  const handleApproval = async (id: string, approvalStatus: ApprovalStatus) => {
    try {
      await apiFetch(`/api/admin/invite-codes/users/${id}/approval`, {
        method: 'PATCH',
        body: JSON.stringify({ approvalStatus }),
      });
      setPendingUsers((current) => current.filter((item) => item._id !== id));
      setMessage(approvalStatus === 'active' ? '账号已通过审核' : '账号已处理');
    } catch (err) {
      setError(err instanceof Error ? err.message : '账号审核失败，请稍后重试。');
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-surface-primary text-text-primary">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
        <header className="flex flex-col gap-2 border-b border-border-light pb-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-active-alt">
              <KeyRound className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold">邀请码管理</h1>
              <p className="text-sm text-text-secondary">
                生成员工注册邀请码，并审核新注册账号后再开通使用。
              </p>
            </div>
          </div>
        </header>

        {(message || error) && (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              error
                ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'
                : 'border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
            }`}
          >
            {error || message}
          </div>
        )}

        <section className="rounded-lg border border-border-light bg-surface-primary-alt p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">生成邀请码</h2>
              <p className="text-sm text-text-secondary">当前可用邀请码：{activeInviteCount} 个</p>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-border-medium px-3 py-2 text-sm hover:bg-surface-hover"
              onClick={loadData}
              disabled={isLoading}
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              刷新
            </button>
          </div>

          <div className="grid gap-3 lg:grid-cols-[120px_150px_220px_minmax(0,1fr)_auto]">
            <label className="grid gap-2 text-sm font-medium">
              生成数量
              <input
                type="number"
                min={1}
                max={100}
                value={count}
                className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm"
                onChange={(event) => setCount(Number(event.target.value))}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              最大使用次数
              <input
                type="number"
                min={1}
                max={1000}
                value={maxUses}
                className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm"
                onChange={(event) => setMaxUses(Number(event.target.value))}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              过期时间
              <input
                type="datetime-local"
                value={expiresAt}
                className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm"
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              备注
              <input
                value={note}
                className="rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm"
                placeholder="例如：运营一组入职"
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="mt-7 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-surface-primary disabled:opacity-60"
              onClick={handleGenerate}
              disabled={isGenerating}
            >
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              生成
            </button>
          </div>
        </section>

        <section className="rounded-lg border border-border-light bg-surface-primary-alt p-5">
          <h2 className="mb-4 text-lg font-semibold">邀请码列表</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead className="bg-surface-active-alt">
                <tr>
                  <th className="border border-border-light px-3 py-2 text-left">邀请码</th>
                  <th className="border border-border-light px-3 py-2 text-left">状态</th>
                  <th className="border border-border-light px-3 py-2 text-left">使用次数</th>
                  <th className="border border-border-light px-3 py-2 text-left">过期时间</th>
                  <th className="border border-border-light px-3 py-2 text-left">备注</th>
                  <th className="border border-border-light px-3 py-2 text-left">创建时间</th>
                  <th className="border border-border-light px-3 py-2 text-left">操作</th>
                </tr>
              </thead>
              <tbody>
                {inviteCodes.map((item) => (
                  <tr key={item._id}>
                    <td className="border border-border-light px-3 py-2 font-mono">{item.code}</td>
                    <td className="border border-border-light px-3 py-2">{statusText[item.status]}</td>
                    <td className="border border-border-light px-3 py-2">
                      {item.usedCount} / {item.maxUses}
                    </td>
                    <td className="border border-border-light px-3 py-2">{formatDate(item.expiresAt)}</td>
                    <td className="border border-border-light px-3 py-2">{item.note || '-'}</td>
                    <td className="border border-border-light px-3 py-2">{formatDate(item.createdAt)}</td>
                    <td className="border border-border-light px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-border-medium px-2 py-1 hover:bg-surface-hover"
                          onClick={() => copyText(item.code)}
                        >
                          <Copy className="h-3.5 w-3.5" />
                          复制
                        </button>
                        {item.status === 'active' && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded border border-border-medium px-2 py-1 hover:bg-surface-hover"
                            onClick={() => handleDisable(item._id)}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            停用
                          </button>
                        )}
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-red-300 px-2 py-1 text-red-600 hover:bg-red-50"
                          onClick={() => handleDelete(item._id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!inviteCodes.length && (
                  <tr>
                    <td className="border border-border-light px-3 py-8 text-center text-text-secondary" colSpan={7}>
                      暂无邀请码
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-lg border border-border-light bg-surface-primary-alt p-5">
          <h2 className="mb-4 text-lg font-semibold">账号审核</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead className="bg-surface-active-alt">
                <tr>
                  <th className="border border-border-light px-3 py-2 text-left">姓名</th>
                  <th className="border border-border-light px-3 py-2 text-left">邮箱</th>
                  <th className="border border-border-light px-3 py-2 text-left">状态</th>
                  <th className="border border-border-light px-3 py-2 text-left">注册时间</th>
                  <th className="border border-border-light px-3 py-2 text-left">操作</th>
                </tr>
              </thead>
              <tbody>
                {pendingUsers.map((user) => (
                  <tr key={user._id}>
                    <td className="border border-border-light px-3 py-2">{user.name || user.username || '-'}</td>
                    <td className="border border-border-light px-3 py-2">{user.email}</td>
                    <td className="border border-border-light px-3 py-2">待审核</td>
                    <td className="border border-border-light px-3 py-2">{formatDate(user.createdAt)}</td>
                    <td className="border border-border-light px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-green-300 px-2 py-1 text-green-700 hover:bg-green-50"
                          onClick={() => handleApproval(user._id, 'active')}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          通过
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-red-300 px-2 py-1 text-red-600 hover:bg-red-50"
                          onClick={() => handleApproval(user._id, 'rejected')}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          拒绝
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!pendingUsers.length && (
                  <tr>
                    <td className="border border-border-light px-3 py-8 text-center text-text-secondary" colSpan={5}>
                      暂无待审核账号
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
