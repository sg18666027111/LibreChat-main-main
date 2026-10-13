import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminPasswordResetDialog from './AdminPasswordResetDialog';

jest.mock('librechat-data-provider', () => ({ getTokenHeader: () => 'Bearer manager-token' }));
const fetchMock = jest.fn();
const target = { id: 'user-1', email: 'employee@example.com' };
const response = {
  link: 'https://example.com/reset-password?token=one-time-secret',
  expiresAt: '2026-09-19T12:15:00.000Z',
};

beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => response });
});

test('requires identity confirmation, issues the link for the selected user and supports copying it', async () => {
  const copy = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  render(<AdminPasswordResetDialog account={target} onClose={jest.fn()} />);
  expect(screen.getByText(target.email)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '生成重置链接' })).toBeDisabled();
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '生成重置链接' }));
  expect(await screen.findByLabelText('重置链接')).toHaveValue(response.link);
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/admin/accounts/user-1/password-reset-link',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer manager-token' }),
      cache: 'no-store',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: '复制链接' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(response.link));
  expect(
    await screen.findByText('链接已复制，请仅私聊发送给已核实身份的本人。'),
  ).toBeInTheDocument();
});

test('an API error does not expose a link and allows retry', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ message: '无权重置此账号' }) });
  render(<AdminPasswordResetDialog account={target} onClose={jest.fn()} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '生成重置链接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('无权重置此账号');
  expect(screen.queryByLabelText('重置链接')).toBeNull();
  expect(screen.getByRole('button', { name: '生成重置链接' })).toBeEnabled();
});

test('clipboard denial leaves the link selectable and explains manual copying', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
  });
  render(<AdminPasswordResetDialog account={target} onClose={jest.fn()} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '生成重置链接' }));
  await screen.findByLabelText('重置链接');
  fireEvent.click(screen.getByRole('button', { name: '复制链接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('复制失败，请手动选中并复制链接。');
  expect(screen.getByLabelText('重置链接')).toHaveValue(response.link);
});
