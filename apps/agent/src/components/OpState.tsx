import type { OutboxOp } from '../lib/offline';
import { useApp } from '../lib/app-state';
import type { Key } from '../lib/i18n';
import { Badge } from './ui';

export const FLAG_TEXT: Record<string, Key> = {
  REASSIGNED_BEFORE_SYNC: 'flagReassigned',
  NOT_ASSIGNED_AT_COLLECTION: 'flagNotAssigned',
  CUSTOMER_INACTIVE: 'flagInactive',
  POSSIBLE_DUPLICATE: 'flagDuplicate',
  CLOCK_SKEW: 'flagClock',
  LATE_SYNC: 'flagLate',
};

export const outcomeKey: Record<string, Key> = {
  PAYMENT_COLLECTED: 'outcomePaid',
  PARTIAL_PAYMENT: 'partlyPaid',
  NOT_AVAILABLE: 'outcomeNotAvailable',
  REFUSED: 'outcomeRefused',
  WILL_PAY_LATER: 'outcomeLater',
  ALREADY_PAID_ADMIN: 'outcomePaidAdmin',
  WRONG_ADDRESS: 'outcomeWrongAddress',
  SERVICE_DISCONTINUED: 'outcomeDiscontinued',
  OTHER: 'outcomeOther',
};

/** Where an entry made on this phone stands, in the agent's words. */
export function OpStateBadge({ op }: { op: OutboxOp }) {
  const { t } = useApp();
  switch (op.state) {
    case 'PENDING':
      return <Badge tone="warn" text={t('notSentYet')} />;
    case 'APPLIED':
      return <Badge tone="good" text={t('sentToOffice')} />;
    case 'NEEDS_REVIEW':
      return <Badge tone="info" text={t('officeWillCheck')} />;
    case 'REJECTED':
      return <Badge tone="bad" text={t('notAccepted')} />;
  }
}
