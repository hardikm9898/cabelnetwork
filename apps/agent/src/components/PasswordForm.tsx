import { useState } from 'react';
import { ApiError } from '../lib/api';
import { useApp } from '../lib/app-state';
import { Button, ErrorBox, Field, Screen, T } from './ui';

/** Current + new password (twice). Used for the forced first change and from Profile. */
export function PasswordForm({ intro, currentLabel, onDone }: { intro: string; currentLabel?: string; onDone?: () => void }) {
  const { changePassword, t } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mismatch = again.length > 0 && again !== next;
  const strong = next.length >= 8 && /[A-Za-z]/.test(next) && /\d/.test(next);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      onDone?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const fieldError = error instanceof ApiError && error.code === 'VALIDATION_FAILED' ? t('passwordRules') : null;

  return (
    <Screen>
      <T>{intro}</T>
      <Field label={currentLabel ?? t('currentPassword')} value={current} onChangeText={setCurrent} secureTextEntry />
      <Field label={t('newPassword')} value={next} onChangeText={setNext} secureTextEntry hint={t('passwordRules')} error={fieldError} />
      <Field label={t('confirmPassword')} value={again} onChangeText={setAgain} secureTextEntry error={mismatch ? t('passwordsDiffer') : null} />
      {!fieldError && <ErrorBox error={error} />}
      <Button testID="save-password" title={t('save')} busy={busy} disabled={!current || !strong || next !== again} onPress={submit} />
    </Screen>
  );
}
