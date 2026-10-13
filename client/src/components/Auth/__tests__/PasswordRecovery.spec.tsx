import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RequestPasswordReset from '../RequestPasswordReset';
import ResetPassword from '../ResetPassword';

const mockRequest = jest.fn();
const mockReset = jest.fn();
const mockNavigate = jest.fn();
const mockSetError = jest.fn();
const mockHeader = jest.fn();
let mockSuccess = false;
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useOutletContext: () => ({
    startupConfig: { minPasswordLength: 8 },
    setError: mockSetError,
    setHeaderText: mockHeader,
  }),
  useSearchParams: () => [new URLSearchParams('token=one-time-token&userId=test-user')],
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useRequestPasswordResetMutation: () => ({ mutate: mockRequest, isLoading: false }),
  useResetPasswordMutation: () => ({ mutate: mockReset, isSuccess: mockSuccess }),
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockSuccess = false;
});

test('forgot password directs the user to an administrator without collecting email or issuing requests', () => {
  render(<RequestPasswordReset />);
  expect(screen.getByText('com_auth_reset_password_contact_admin')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(mockRequest).not.toHaveBeenCalled();
  expect(screen.getByRole('link')).toHaveAttribute('href', '/login');
});

test('reset form submits the link token, user id and matching new password', async () => {
  render(<ResetPassword />);
  await userEvent.type(screen.getByLabelText('com_auth_password'), 'NewPassword123!');
  await userEvent.type(screen.getByLabelText('com_auth_password_confirm'), 'NewPassword123!');
  fireEvent.submit(screen.getByRole('form', { name: 'Password reset form' }));
  await waitFor(() =>
    expect(mockReset).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'one-time-token',
        userId: 'test-user',
        password: 'NewPassword123!',
      }),
      expect.any(Object),
    ),
  );
});

test('successful reset offers a return to login', async () => {
  mockSuccess = true;
  render(<ResetPassword />);
  await userEvent.click(screen.getByLabelText('com_auth_sign_in'));
  expect(mockNavigate).toHaveBeenCalledWith('/login');
});
