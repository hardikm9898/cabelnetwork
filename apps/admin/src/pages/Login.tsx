import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ClipboardList } from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorNote, Field, Input, PASSWORD_HINT, PasswordInput } from '../components/ui';

export function LoginPage() {
  const { status, me, login } = useAuth();
  const navigate = useNavigate();
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (status === 'authenticated' && me) return <Navigate to={me.mustChangePassword ? '/change-password' : '/'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(mobile, password);
      navigate(user.mustChangePassword ? '/change-password' : '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="grid size-9 place-items-center rounded-xl bg-brand-700 text-white">
            <ClipboardList className="size-5" aria-hidden />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Cable Network</h1>
            <p className="text-xs text-muted">Admin sign in</p>
          </div>
        </div>
        <Field label="Mobile number">
          {(id) => <Input id={id} inputMode="tel" autoComplete="username" value={mobile} onChange={(e) => setMobile(e.target.value)} required autoFocus />}
        </Field>
        <Field label="Password">
          {(id) => <PasswordInput id={id} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" busy={busy} className="w-full">
          Sign in
        </Button>
      </form>
    </div>
  );
}

export function ChangePasswordPage() {
  const { reload } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mismatch = confirm.length > 0 && next !== confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/change-password', { body: { currentPassword: current, newPassword: next } });
      await reload();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const fieldErr = error instanceof ApiError ? error.fieldErrors() : {};

  return (
    <div className="grid min-h-full place-items-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold">Set a new password</h1>
          <p className="text-sm text-muted">Replace your temporary password to continue. {PASSWORD_HINT}.</p>
        </div>
        <Field label="Current password">{(id) => <PasswordInput id={id} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />}</Field>
        <Field label="New password" error={fieldErr.newPassword}>
          {(id) => <PasswordInput id={id} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />}
        </Field>
        <Field label="Confirm new password" error={mismatch ? 'Passwords do not match' : undefined}>
          {(id) => <PasswordInput id={id} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
        </Field>
        {!(error instanceof ApiError && error.code === 'VALIDATION_FAILED') && <ErrorNote error={error} />}
        <Button type="submit" busy={busy} disabled={mismatch} className="w-full">
          Save password
        </Button>
      </form>
    </div>
  );
}
