import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AccountAdmin from './AccountAdmin';

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { role: 'ADMIN', adminRole: 'super_admin' } }),
}));

jest.mock('librechat-data-provider', () => ({
  getTokenHeader: () => 'Bearer test-token',
  SystemRoles: {
    ADMIN: 'ADMIN',
  },
}));

const targetAccount = {
  id: 'target-user-id',
  name: '目标员工',
  username: 'target',
  email: 'Target.User+Case@Example.com',
  role: 'USER',
  adminRole: 'user' as const,
  provider: 'local',
  approvalStatus: 'active' as const,
  canManageImagePromptTemplates: false,
  usage24h: {
    eventCount: 0,
    costCny: 0,
    inputTokens: 0,
    outputTokens: 0,
    imageCount: 0,
  },
};

const secondAccount = {
  ...targetAccount,
  id: 'second-user-id',
  name: '第二员工',
  username: 'second',
  email: 'second.employee@example.com',
};

const accountsResponse = {
  users: [targetAccount, secondAccount],
  total: 2,
};

const jsonResponse = (data: unknown) =>
  Promise.resolve({
    ok: true,
    json: async () => data,
  } as Response);

const fetchMock = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;

function mockAdminApi() {
  fetchMock.mockImplementation((input, init) => {
    const url = String(input);
    if (url.startsWith('/api/admin/accounts?')) {
      return jsonResponse(accountsResponse);
    }
    if (url.startsWith('/api/admin/prompt-template-permissions?')) {
      return jsonResponse({ records: [], total: 0 });
    }
    if (url.startsWith('/api/admin/usage/dashboard')) {
      return jsonResponse({
        hours: 24,
        totals: {
          eventCount: 0,
          costCny: 0,
          inputTokens: 0,
          outputTokens: 0,
          imageCount: 0,
          userCount: 0,
          failedCount: 0,
        },
        byUser: [],
        byModel: [],
        byBusiness: [],
        recentEvents: [],
      });
    }
    if (url.startsWith('/api/admin/usage/reports?')) {
      return jsonResponse({ reports: [] });
    }
    if (url.startsWith('/api/admin/usage/prices')) {
      return jsonResponse({ prices: [] });
    }
    if (url.startsWith('/api/admin/usage/settings')) {
      return jsonResponse({ settings: { enabled: false, recipients: [] } });
    }
    if (url.endsWith('/permanent-delete') && init?.method === 'POST') {
      return jsonResponse({ job: { status: 'completed' } });
    }
    throw new Error(`Unhandled request: ${url}`);
  });
}

async function renderAccounts() {
  mockAdminApi();
  render(<AccountAdmin />);
  await screen.findByText(targetAccount.email);
}

function openDeleteDialogFor(email: string) {
  const row = screen.getByText(email).closest('tr');
  expect(row).not.toBeNull();
  fireEvent.click(within(row as HTMLTableRowElement).getByRole('button', { name: '彻底删除' }));
  return screen.getByRole('dialog', { name: '彻底删除账号' });
}

describe('AccountAdmin permanent deletion dialog', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it('shows the target account as read-only text and uses autofill-resistant confirmation fields', async () => {
    await renderAccounts();

    const dialog = openDeleteDialogFor(targetAccount.email);

    expect(within(dialog).getByText('目标员工')).toBeInTheDocument();
    expect(within(dialog).getByText(targetAccount.email)).toBeInTheDocument();

    const confirmation = within(dialog).getByLabelText(
      '请输入目标账号邮箱以确认',
    ) as HTMLInputElement;
    expect(confirmation).toHaveValue('');
    expect(confirmation).toHaveAttribute('type', 'text');
    expect(confirmation).toHaveAttribute('name', 'delete-target-confirmation');
    expect(confirmation).toHaveAttribute('autocomplete', 'off');

    const password = within(dialog).getByLabelText('请输入当前超级管理员密码') as HTMLInputElement;
    expect(password).toHaveValue('');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('name', 'delete-admin-approval-secret');
    expect(password).toHaveAttribute('autocomplete', 'new-password');
    expect(password).toHaveAttribute('data-lpignore', 'true');
    expect(password).toHaveAttribute('data-1p-ignore', 'true');
    expect(password).toHaveAttribute('data-bwignore', 'true');

    expect(dialog.closest('form')).toBeNull();
  });

  it('resets confirmation fields and updates read-only target information between employees', async () => {
    await renderAccounts();

    let dialog = openDeleteDialogFor(targetAccount.email);
    fireEvent.change(within(dialog).getByLabelText('请输入目标账号邮箱以确认'), {
      target: { value: targetAccount.email },
    });
    fireEvent.change(within(dialog).getByLabelText('请输入当前超级管理员密码'), {
      target: { value: 'typed-password' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    dialog = openDeleteDialogFor(secondAccount.email);

    expect(within(dialog).getByText('第二员工')).toBeInTheDocument();
    expect(within(dialog).getByText(secondAccount.email)).toBeInTheDocument();
    expect(within(dialog).queryByText(targetAccount.email)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('请输入目标账号邮箱以确认')).toHaveValue('');
    expect(within(dialog).getByLabelText('请输入当前超级管理员密码')).toHaveValue('');
  });

  it('requires the typed confirmation email to exactly match the target email before deleting', async () => {
    await renderAccounts();
    const dialog = openDeleteDialogFor(targetAccount.email);

    fireEvent.change(within(dialog).getByLabelText('请输入目标账号邮箱以确认'), {
      target: { value: targetAccount.email.toLowerCase() },
    });
    fireEvent.change(within(dialog).getByLabelText('请输入当前超级管理员密码'), {
      target: { value: 'correct-admin-password' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));

    expect(await screen.findByText('邮箱确认不匹配。')).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining('/permanent-delete'),
        expect.anything(),
      );
    });
  });
});

test('account management opens a reset dialog for the selected employee and clears it on close', async () => {
  global.fetch = fetchMock;
  await renderAccounts();
  const row = screen.getByText(targetAccount.email).closest('tr');
  fireEvent.click(within(row as HTMLTableRowElement).getByRole('button', { name: '重置密码' }));
  const dialog = screen.getByRole('dialog', { name: '重置账号密码' });
  expect(within(dialog).getByText(targetAccount.email)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('checkbox'));
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('dialog', { name: '重置账号密码' })).toBeNull();
  const secondRow = screen.getByText(secondAccount.email).closest('tr');
  fireEvent.click(
    within(secondRow as HTMLTableRowElement).getByRole('button', { name: '重置密码' }),
  );
  const nextDialog = screen.getByRole('dialog', { name: '重置账号密码' });
  expect(within(nextDialog).getByText(secondAccount.email)).toBeInTheDocument();
  expect(within(nextDialog).getByRole('checkbox')).not.toBeChecked();
});
