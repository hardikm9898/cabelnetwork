/** Shapes of the API responses the agent app reads (see apps/api CollectionsService etc.). */
export interface MyDay {
  today: string;
  assignedCustomers: number;
  temporaryCustomers: number;
  totalOutstanding: string;
  expectedToday: string;
  collectedToday: string;
  remainingToday: string;
  byMode: { cash: string; upi: string; other: string };
  pendingVerification: string;
  customersPaid: number;
  customersPartiallyPaid: number;
  customersNotAvailable: number;
  visitsToday: number;
  pendingFollowUps: number;
  dueToday: number;
  overdue: number;
  cashInHand: string;
  cashNotYetHandedOver: string;
  pendingHandoverAmount: string;
}

export type CollectionStatus = 'PAID' | 'PARTIAL' | 'VISITED' | 'PENDING' | 'CLEAR';

export interface WorkItem {
  id: string;
  customerCode: string;
  name: string;
  mobile: string | null;
  addressLine: string;
  landmark: string | null;
  society: string;
  assignment: 'PRIMARY' | 'TEMPORARY';
  outstanding: string;
  advance: string;
  oldestDueDate: string | null;
  nextDueDate: string | null;
  dueToday: boolean;
  overdue: boolean;
  lastPaymentDate: string | null;
  lastPaymentAmount: string | null;
  paidToday: string;
  pendingVerificationToday: string;
  lastVisitAt: string | null;
  lastVisitOutcome: string | null;
  visitedToday: boolean;
  followUpDue: boolean;
  status: CollectionStatus;
}

export interface Worklist {
  today: string;
  counts: Record<'all' | 'due_today' | 'overdue' | 'partial' | 'pending' | 'paid' | 'follow_up', number>;
  items: WorkItem[];
}

export interface Customer {
  id: string;
  customerCode: string;
  name: string;
  mobile: string | null;
  mobileValid: boolean;
  addressLine: string;
  landmark: string | null;
  status: string;
  society: { id: string; name: string };
  currentAgent: { kind: string } | null;
}

export interface Balance {
  outstanding: string;
  advance: string;
  overdueAmount: string;
  oldestDueDate: string | null;
  openInvoices: { id: string; periodStart: string | null; periodEnd: string | null; balance: string; overdue: boolean; kind: string }[];
  lastPayment: { amount: string; paymentDate: string; mode: string } | null;
  pendingVerification: { id: string; amount: string; mode: string }[];
}

export interface Subscription {
  currentMonthlyRate: string | null;
  billingIntervalMonths: number;
  nextBilling: { billingDate: string; amount: string } | null;
}
