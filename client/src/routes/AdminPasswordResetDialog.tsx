/* eslint-disable i18next/no-literal-string */
import { useState } from 'react';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import { getTokenHeader } from 'librechat-data-provider';

type ResetLink = { link: string; expiresAt: string };

export default function AdminPasswordResetDialog({
  account,
  onClose,
}: {
  account: { id: string; email: string };
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ResetLink | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    if (!confirmed || pending) return;
    setPending(true);
    setError('');
    try {
      const authorization = getTokenHeader();
      const response = await fetch(`/api/admin/accounts/${account.id}/password-reset-link`, {
        method: 'POST',
        cache: 'no-store',
        headers: { ...(authorization ? { Authorization: authorization } : {}) },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || '生成失败，请稍后重试。');
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败，请稍后重试。');
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    setError('');
    try {
      await navigator.clipboard.writeText(result.link);
      setCopied(true);
    } catch {
      setError('复制失败，请手动选中并复制链接。');
    }
  };

  return (
    <OGDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <OGDialogContent className="w-11/12 max-w-lg">
        <OGDialogHeader>
          <OGDialogTitle>重置账号密码</OGDialogTitle>
        </OGDialogHeader>
        <p className="break-all text-sm font-medium">{account.email}</p>
        <p className="text-sm text-text-secondary">
          请先通过公司内部渠道核实本人身份。链接有效期为 15
          分钟，只能使用一次；重新生成会使旧链接失效。
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {result ? (
          <>
            <label className="flex flex-col gap-2 text-sm">
              重置链接
              <textarea
                readOnly
                value={result.link}
                onFocus={(event) => event.currentTarget.select()}
                rows={4}
                className="w-full rounded-md border border-border-medium bg-surface-primary p-2"
              />
            </label>
            <p className="text-sm text-text-secondary">
              失效时间：{new Date(result.expiresAt).toLocaleString('zh-CN', { hour12: false })}
            </p>
            <p className="text-sm text-text-secondary">
              用户设置新密码后，原有登录状态将失效，账号审批状态不变。关闭此窗口后不再显示链接。
            </p>
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded-md bg-green-600 px-3 py-2 text-sm text-white"
            >
              复制链接
            </button>
            {copied && (
              <p role="status" className="text-sm">
                链接已复制，请仅私聊发送给已核实身份的本人。
              </p>
            )}
          </>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                disabled={pending}
              />
              已通过公司内部渠道核实本人身份
            </label>
            <button
              type="button"
              disabled={!confirmed || pending}
              onClick={() => void generate()}
              className="rounded-md bg-green-600 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {pending ? '正在生成…' : '生成重置链接'}
            </button>
          </>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={onClose}
          className="rounded-md border border-border-medium px-3 py-2 text-sm"
        >
          关闭
        </button>
      </OGDialogContent>
    </OGDialog>
  );
}
