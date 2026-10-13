import { loginPage } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

function RequestPasswordReset() {
  const localize = useLocalize();
  return (
    <div className="mt-8 space-y-6">
      <p className="text-sm leading-6 text-text-secondary">
        {localize('com_auth_reset_password_contact_admin')}
      </p>
      <a
        href={loginPage()}
        className="block text-center text-sm font-medium text-green-600 hover:text-green-700 dark:text-green-400"
      >
        {localize('com_auth_back_to_login')}
      </a>
    </div>
  );
}

export default RequestPasswordReset;
