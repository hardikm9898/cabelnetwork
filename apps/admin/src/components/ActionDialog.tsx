import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError, newKey } from '../lib/api';
import { Button, ErrorNote, Modal } from './ui';

/**
 * A form in a dialog. Keeps one idempotency key per opening (safe retries), shows API errors,
 * and exposes field errors to the form body.
 */
export function ActionDialog({
  open,
  onClose,
  title,
  submitLabel = 'Save',
  danger,
  wide,
  onSubmit,
  children,
  disabled,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  submitLabel?: string;
  danger?: boolean;
  wide?: boolean;
  disabled?: boolean;
  onSubmit: (idempotencyKey: string) => Promise<unknown>;
  children: (fieldErrors: Record<string, string>) => ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const key = useRef(newKey());
  useEffect(() => {
    if (open) {
      key.current = newKey();
      setError(null);
    }
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(key.current);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const fieldErrors = error instanceof ApiError ? error.fieldErrors() : {};
  const formId = `form-${title.replace(/\W+/g, '-')}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      wide={wide}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant={danger ? 'danger' : 'primary'} busy={busy} disabled={disabled}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3">
        {children(fieldErrors)}
        {!(error instanceof ApiError && error.code === 'VALIDATION_FAILED' && Object.keys(fieldErrors).length > 0) && <ErrorNote error={error} />}
      </form>
    </Modal>
  );
}
