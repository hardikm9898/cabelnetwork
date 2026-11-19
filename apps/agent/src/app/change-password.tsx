import { useApp } from '../lib/app-state';
import { PasswordForm } from '../components/PasswordForm';

/** Forced first change of the temporary password; continues to PIN setup. */
export default function ChangePassword() {
  const { t } = useApp();
  return <PasswordForm intro={t('changePasswordFirst')} />;
}
