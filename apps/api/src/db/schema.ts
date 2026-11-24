/**
 * Kysely table types (camelCase; CamelCasePlugin maps to snake_case columns).
 * Keep in sync with db/migrations/*.sql.
 *
 * Type conventions: `date` columns are returned as 'YYYY-MM-DD' strings (pg parser override),
 * `numeric` and `bigint` as strings, ranges as their text form.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { Role } from '@cablenet/domain';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<unknown, string | undefined | null, string | null>;

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
export type CustomerStatusDb = 'ACTIVE' | 'SUSPENDED' | 'INACTIVE' | 'DISCONNECTED';
export type AssignmentKind = 'PRIMARY' | 'TEMPORARY';
export type AssignmentSource = 'AREA_DEFAULT' | 'MANUAL' | 'IMPORT' | 'TEMP_REASSIGNMENT';

export interface UsersTable {
  id: Generated<string>;
  fullName: string;
  mobile: string;
  email: string | null;
  passwordHash: string;
  role: Role;
  status: Generated<UserStatus>;
  mustChangePassword: Generated<boolean>;
  failedLoginCount: Generated<number>;
  lockedUntil: NullableTimestamp;
  lastLoginAt: NullableTimestamp;
  passwordChangedAt: NullableTimestamp;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: NullableTimestamp;
  deletedBy: string | null;
}

export interface AgentProfilesTable {
  userId: string;
  agentCode: string;
  photoUrl: string | null;
  joiningDate: string | null;
  employmentStatus: Generated<'ACTIVE' | 'ON_LEAVE' | 'LEFT'>;
  notes: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface DevicesTable {
  id: string;
  userId: string;
  platform: string | null;
  model: string | null;
  appVersion: string | null;
  pushToken: string | null;
  firstSeenAt: Generated<Date>;
  lastSeenAt: Generated<Date>;
  revokedAt: NullableTimestamp;
  lastSyncAt: NullableTimestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  userId: string;
  familyId: string;
  deviceId: string | null;
  refreshTokenHash: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Generated<Date>;
  expiresAt: Timestamp;
  rotatedAt: NullableTimestamp;
  revokedAt: NullableTimestamp;
  revokeReason: string | null;
}

export interface AreasTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  status: Generated<'ACTIVE' | 'INACTIVE'>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: NullableTimestamp;
  deletedBy: string | null;
}

export interface SocietiesTable {
  id: Generated<string>;
  areaId: string | null;
  name: string;
  legacyName: string | null;
  collectionDay: number | null;
  status: Generated<'ACTIVE' | 'INACTIVE'>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: NullableTimestamp;
  deletedBy: string | null;
}

export interface CustomersTable {
  id: Generated<string>;
  customerCode: string;
  name: string;
  mobile: string | null;
  mobileValid: Generated<boolean>;
  altMobile: string | null;
  addressLine: string;
  landmark: string | null;
  societyId: string;
  latitude: string | null;
  longitude: string | null;
  collectionDay: number | null;
  paymentPreferenceMonths: number | null;
  status: Generated<CustomerStatusDb>;
  statusReason: string | null;
  notes: string | null;
  importBatchId: string | null;
  pendingDecision: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: NullableTimestamp;
  deletedBy: string | null;
  deleteReason: string | null;
  deactivatedAt: NullableTimestamp;
}

export interface CustomerConnectionsTable {
  id: Generated<string>;
  customerId: string;
  stbNumber: string;
  mqNumber: string | null;
  activeFrom: string;
  activeTo: string | null;
  reason: string | null;
  createdAt: Generated<Date>;
  createdBy: string | null;
}

export interface AreaAgentAssignmentsTable {
  id: Generated<string>;
  areaId: string;
  agentId: string;
  validDuring: string;
  reason: string | null;
  createdBy: string;
  createdAt: Generated<Date>;
  endedBy: string | null;
  endedReason: string | null;
}

export interface TempReassignmentsTable {
  id: Generated<string>;
  fromAgentId: string;
  toAgentId: string;
  scope: 'ALL_OF_AGENT' | 'SOCIETIES' | 'CUSTOMERS';
  scopeIds: string[] | null;
  startsOn: string;
  endsOn: string;
  reason: string;
  customerCount: number;
  createdBy: string;
  createdAt: Generated<Date>;
  revokedBy: string | null;
  revokedAt: NullableTimestamp;
  revokeReason: string | null;
  startNotifiedAt: NullableTimestamp;
  endNotifiedAt: NullableTimestamp;
}

export interface CustomerAgentAssignmentsTable {
  id: Generated<string>;
  customerId: string;
  agentId: string;
  kind: AssignmentKind;
  source: AssignmentSource;
  validDuring: string;
  tempReassignmentId: string | null;
  reason: string | null;
  createdBy: string;
  createdAt: Generated<Date>;
  endedBy: string | null;
  endedAt: NullableTimestamp;
  endedReason: string | null;
}

export interface CustomerCurrentAgentView {
  customerId: string;
  agentId: string;
  kind: AssignmentKind;
  source: AssignmentSource;
  assignmentId: string;
  tempReassignmentId: string | null;
}

export interface CustomerPrimaryAgentView {
  customerId: string;
  agentId: string;
  source: AssignmentSource;
  assignmentId: string;
}

export interface AuditLogsTable {
  id: Generated<string>;
  occurredAt: Generated<Date>;
  actorUserId: string | null;
  actorRole: Role | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: Json;
  after: Json;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  deviceId: string | null;
  sessionId: string | null;
}

export interface NotificationsTable {
  id: Generated<string>;
  userId: string;
  type: string;
  title: string;
  body: string;
  data: Json;
  readAt: NullableTimestamp;
  createdAt: Generated<Date>;
}

export interface BusinessSettingsTable {
  key: string;
  value: Json;
  updatedBy: string | null;
  updatedAt: Generated<Date>;
}


// ---------------------------------------------------------------------------
// Phase 3: financial tables (db/migrations/0002_financial.sql)
// Money columns are numeric(12,2) and come back as strings; convert with toPaise().
// ---------------------------------------------------------------------------
type Money = ColumnType<string, string, string>;
export type PaymentMode = 'CASH' | 'UPI' | 'BANK_TRANSFER' | 'CHEQUE' | 'OTHER' | 'LEGACY_UNKNOWN';
export type PaymentStatus = 'PENDING_VERIFICATION' | 'CONFIRMED' | 'FAILED' | 'REVERSED';
export type PaymentSource = 'AGENT_COLLECTION' | 'ADMIN_COLLECTION' | 'ONLINE' | 'IMPORT' | 'OTHER_AUTHORISED';
export type InvoiceKind = 'SUBSCRIPTION' | 'OPENING_BALANCE' | 'DEBIT_ADJUSTMENT';
export type InvoiceStatus = 'DRAFT' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED';
export type LedgerType =
  | 'OPENING_BALANCE'
  | 'CHARGE'
  | 'PAYMENT'
  | 'DISCOUNT'
  | 'DEBIT_ADJUSTMENT'
  | 'CREDIT_ADJUSTMENT'
  | 'REFUND'
  | 'REVERSAL';

export interface NumberSequencesTable {
  name: string;
  fiscalYear: string;
  nextValue: Generated<string>;
}

export interface CustomerSubscriptionsTable {
  id: Generated<string>;
  customerId: string;
  status: Generated<'ACTIVE' | 'SUSPENDED' | 'ENDED'>;
  startDate: string;
  endDate: string | null;
  billingMode: Generated<'AUTO' | 'MANUAL'>;
  billingIntervalMonths: Generated<number>;
  billingAnchorDay: number;
  billingTiming: Generated<'ADVANCE' | 'ARREARS'>;
  dueDays: Generated<number>;
  nextPeriodStart: string;
  notes: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface SubscriptionRatesTable {
  id: Generated<string>;
  subscriptionId: string;
  monthlyRate: Money;
  effectiveFrom: string;
  reason: string | null;
  createdBy: string | null;
  createdAt: Generated<Date>;
}

export interface SubscriptionSuspensionsTable {
  id: Generated<string>;
  subscriptionId: string;
  fromDate: string;
  toDate: string | null;
  reason: string;
  createdBy: string | null;
  createdAt: Generated<Date>;
  endedBy: string | null;
  endedReason: string | null;
  cancelledAt: NullableTimestamp;
}

export interface BillingRunsTable {
  id: Generated<string>;
  asOf: string;
  trigger: 'SCHEDULED' | 'MANUAL';
  triggeredBy: string | null;
  startedAt: Generated<Date>;
  finishedAt: NullableTimestamp;
  status: Generated<'RUNNING' | 'COMPLETED' | 'FAILED'>;
  invoicesCreated: Generated<number>;
  periodsSkipped: Generated<number>;
  errors: ColumnType<unknown, string | undefined, string>;
}

export interface InvoicesTable {
  id: Generated<string>;
  invoiceNumber: string | null;
  kind: InvoiceKind;
  customerId: string;
  subscriptionId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  billingDate: string;
  dueDate: string;
  subtotal: Money;
  discountTotal: ColumnType<string, string | undefined, string>;
  total: Money;
  amountPaid: ColumnType<string, string | undefined, string>;
  previousOutstandingSnapshot: string | null;
  status: InvoiceStatus;
  description: string | null;
  billingRunId: string | null;
  source: 'SCHEDULER' | 'ADMIN' | 'IMPORT';
  externalRef: string | null;
  createdAt: Generated<Date>;
  createdBy: string | null;
  cancelledAt: NullableTimestamp;
  cancelledBy: string | null;
  cancelReason: string | null;
}

export interface InvoiceItemsTable {
  id: Generated<string>;
  invoiceId: string;
  itemType: 'SUBSCRIPTION' | 'DISCOUNT' | 'ADJUSTMENT' | 'OPENING_BALANCE';
  description: string;
  months: number | null;
  unitRate: string | null;
  amount: Money;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface PaymentsTable {
  id: Generated<string>;
  clientTxnId: string;
  customerId: string;
  amount: Money;
  paymentDate: string;
  receivedAt: NullableTimestamp;
  mode: PaymentMode;
  reference: string | null;
  source: PaymentSource;
  status: PaymentStatus;
  collectedBy: string | null;
  recordedBy: string | null;
  deviceId: string | null;
  recordedOffline: Generated<boolean>;
  clientRecordedAt: NullableTimestamp;
  verifiedBy: string | null;
  verifiedAt: NullableTimestamp;
  verificationNote: string | null;
  reviewFlags: Generated<string[]>;
  externalRef: string | null;
  notes: string | null;
  provisionalRef: string | null;
  createdAt: Generated<Date>;
}

export interface CreditNotesTable {
  id: Generated<string>;
  creditNumber: string;
  customerId: string;
  kind: 'DISCOUNT' | 'CREDIT_ADJUSTMENT' | 'OPENING_ADVANCE';
  amount: Money;
  creditDate: string;
  targetInvoiceId: string | null;
  reason: string;
  approvedBy: string;
  status: Generated<'ACTIVE' | 'REVERSED'>;
  externalRef: string | null;
  createdAt: Generated<Date>;
  reversedAt: NullableTimestamp;
  reversedBy: string | null;
  reverseReason: string | null;
}

export interface RefundsTable {
  id: Generated<string>;
  refundNumber: string;
  customerId: string;
  amount: Money;
  refundDate: string;
  mode: PaymentMode;
  reference: string | null;
  reason: string;
  approvedBy: string;
  createdAt: Generated<Date>;
}

export interface AllocationsTable {
  id: Generated<string>;
  customerId: string;
  paymentId: string | null;
  creditNoteId: string | null;
  invoiceId: string | null;
  refundId: string | null;
  amount: Money;
  reversesAllocationId: string | null;
  createdAt: Generated<Date>;
  createdBy: string | null;
}

export interface PaymentReversalsTable {
  id: Generated<string>;
  paymentId: string;
  reason: string;
  approvedBy: string;
  createdAt: Generated<Date>;
}

export interface ReceiptsTable {
  id: Generated<string>;
  receiptNumber: string;
  paymentId: string;
  status: Generated<'ISSUED' | 'CANCELLED'>;
  snapshot: ColumnType<unknown, string, string>;
  issuedAt: Generated<Date>;
  issuedBy: string | null;
  reissueOfReceiptId: string | null;
  cancelledAt: NullableTimestamp;
  cancelledBy: string | null;
  cancelReason: string | null;
}

export interface LedgerEntriesTable {
  id: Generated<string>;
  customerId: string;
  entryDate: string;
  postedAt: Generated<Date>;
  type: LedgerType;
  amount: Money;
  invoiceId: string | null;
  paymentId: string | null;
  creditNoteId: string | null;
  refundId: string | null;
  reversesEntryId: string | null;
  description: string;
  createdBy: string | null;
}

export interface CustomerBalancesView {
  customerId: string;
  balance: string;
  outstanding: string;
  advance: string;
}

export interface CashHandoversTable {
  id: Generated<string>;
  handoverNumber: string;
  agentId: string;
  submittedAt: Generated<Date>;
  expectedAmount: Money;
  declaredAmount: Money;
  receivedAmount: string | null;
  difference: string | null;
  status: Generated<'SUBMITTED' | 'CONFIRMED' | 'REJECTED'>;
  notes: string | null;
  verifiedBy: string | null;
  verifiedAt: NullableTimestamp;
  mismatchReason: string | null;
}

export interface CashHandoverItemsTable {
  handoverId: string;
  paymentId: string;
  amount: Money;
}

export interface CashAdjustmentsTable {
  id: Generated<string>;
  agentId: string;
  handoverId: string | null;
  amount: Money;
  kind: 'RECOVERY' | 'WRITE_OFF' | 'CORRECTION';
  reason: string;
  approvedBy: string;
  createdAt: Generated<Date>;
}

export interface IdempotencyKeysTable {
  key: string;
  userId: string;
  route: string;
  requestHash: string;
  status: Generated<'IN_PROGRESS' | 'COMPLETED'>;
  responseStatus: number | null;
  responseBody: Json;
  createdAt: Generated<Date>;
}

export interface SystemAlertsTable {
  id: Generated<string>;
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  entityType: string | null;
  entityId: string | null;
  message: string;
  details: Json;
  createdAt: Generated<Date>;
  resolvedAt: NullableTimestamp;
  resolvedBy: string | null;
  resolution: string | null;
}

export interface JobRunsTable {
  id: Generated<string>;
  job: string;
  businessDate: string;
  startedAt: Generated<Date>;
  finishedAt: NullableTimestamp;
  status: Generated<'RUNNING' | 'COMPLETED' | 'FAILED'>;
  detail: Json;
}

// ---------------------------------------------------------------------------
// Phase 4: field operations (db/migrations/0003_field_ops.sql)
// ---------------------------------------------------------------------------
export type VisitOutcome =
  | 'PAYMENT_COLLECTED'
  | 'PARTIAL_PAYMENT'
  | 'NOT_AVAILABLE'
  | 'REFUSED'
  | 'WILL_PAY_LATER'
  | 'ALREADY_PAID_ADMIN'
  | 'WRONG_ADDRESS'
  | 'SERVICE_DISCONTINUED'
  | 'OTHER';
export type InteractionStatus = 'PENDING' | 'PROMISE_TO_PAY' | 'FOLLOW_UP_REQUIRED' | 'COMPLETED' | 'NOT_INTERESTED';

export interface VisitsTable {
  id: Generated<string>;
  clientId: string;
  customerId: string;
  agentId: string;
  visitedAt: Timestamp;
  outcome: VisitOutcome;
  paymentId: string | null;
  promisedAmount: string | null;
  promisedDate: string | null;
  followUpDate: string | null;
  notes: string | null;
  gpsLat: string | null;
  gpsLng: string | null;
  gpsAccuracyM: number | null;
  deviceId: string | null;
  recordedOffline: Generated<boolean>;
  createdAt: Generated<Date>;
}

export interface InteractionsTable {
  id: Generated<string>;
  customerId: string;
  channel: 'CALL' | 'WHATSAPP' | 'WALK_IN' | 'VISIT' | 'OTHER';
  interactionType: 'PAYMENT_PROMISE' | 'COMPLAINT' | 'QUERY' | 'DISCONNECTION_REQUEST' | 'RECONNECTION_REQUEST' | 'OTHER';
  expectedAmount: string | null;
  promiseDate: string | null;
  followUpDate: string | null;
  status: InteractionStatus;
  notes: string | null;
  recordedBy: string;
  resolvedPaymentId: string | null;
  resolvedAt: NullableTimestamp;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  updatedBy: string | null;
}

export interface FollowUpTasksTable {
  id: Generated<string>;
  customerId: string;
  assignedTo: string | null;
  dueDate: string;
  title: string;
  sourceType: 'VISIT' | 'INTERACTION' | 'MANUAL';
  sourceId: string | null;
  status: Generated<'OPEN' | 'DONE' | 'CANCELLED'>;
  createdBy: string;
  createdAt: Generated<Date>;
  completedAt: NullableTimestamp;
  completedBy: string | null;
  outcomeNote: string | null;
}

export type SyncOpType = 'PAYMENT_CREATE' | 'VISIT_CREATE' | 'FOLLOWUP_DONE';
export type SyncOpStoredStatus = 'APPLIED' | 'NEEDS_REVIEW' | 'REJECTED';

export interface SyncOperationsTable {
  opId: string;
  userId: string;
  deviceId: string | null;
  opType: SyncOpType;
  deviceSeq: number | null;
  clientCreatedAt: Timestamp;
  effectiveAt: Timestamp;
  clockSkewSeconds: Generated<number>;
  recordedOffline: Generated<boolean>;
  payload: ColumnType<unknown, string, string>;
  status: SyncOpStoredStatus;
  flags: Generated<string[]>;
  errorCode: string | null;
  errorMessage: string | null;
  customerId: string | null;
  paymentId: string | null;
  visitId: string | null;
  result: ColumnType<unknown, string | null, string | null>;
  receivedAt: Generated<Date>;
  reviewedBy: string | null;
  reviewedAt: NullableTimestamp;
  reviewNote: string | null;
}

export type ImportStatus = 'ANALYSED' | 'DRY_RUN_OK' | 'DRY_RUN_FAILED' | 'APPROVED' | 'COMMITTED' | 'DISCARDED';
export type ImportOption = 'FULL_HISTORY' | 'OPENING_BALANCE';

export interface ImportBatchesTable {
  id: Generated<string>;
  fileName: string;
  fileSha256: string;
  fileSize: number;
  fileData: Buffer;
  status: Generated<ImportStatus>;
  analysis: ColumnType<unknown, string, string>;
  corrections: ColumnType<unknown, string | undefined, string>;
  option: ImportOption | null;
  cutoverDate: string | null;
  dryRunReport: ColumnType<unknown, string | null | undefined, string | null>;
  dryRunHash: string | null;
  dryRunAt: NullableTimestamp;
  dryRunBy: string | null;
  approvedHash: string | null;
  approvedAt: NullableTimestamp;
  approvedBy: string | null;
  committedAt: NullableTimestamp;
  committedBy: string | null;
  commitReport: ColumnType<unknown, string | null | undefined, string | null>;
  uploadedBy: string;
  uploadedAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface LegacyStatementLinesTable {
  id: Generated<string>;
  customerId: string;
  importBatchId: string;
  month: string;
  rateRaw: string | null;
  rate: Money;
  opening: Money;
  received: Money;
  feeAdjusted: Money;
  closingAdvance: Money;
  amountDue: Money;
  paymentDate: string | null;
  notes: string | null;
}

export interface DB {
  users: UsersTable;
  agentProfiles: AgentProfilesTable;
  devices: DevicesTable;
  sessions: SessionsTable;
  areas: AreasTable;
  societies: SocietiesTable;
  customers: CustomersTable;
  customerConnections: CustomerConnectionsTable;
  areaAgentAssignments: AreaAgentAssignmentsTable;
  tempReassignments: TempReassignmentsTable;
  customerAgentAssignments: CustomerAgentAssignmentsTable;
  customerCurrentAgent: CustomerCurrentAgentView;
  customerPrimaryAgent: CustomerPrimaryAgentView;
  auditLogs: AuditLogsTable;
  notifications: NotificationsTable;
  businessSettings: BusinessSettingsTable;
  numberSequences: NumberSequencesTable;
  customerSubscriptions: CustomerSubscriptionsTable;
  subscriptionRates: SubscriptionRatesTable;
  subscriptionSuspensions: SubscriptionSuspensionsTable;
  billingRuns: BillingRunsTable;
  invoices: InvoicesTable;
  invoiceItems: InvoiceItemsTable;
  payments: PaymentsTable;
  creditNotes: CreditNotesTable;
  refunds: RefundsTable;
  allocations: AllocationsTable;
  paymentReversals: PaymentReversalsTable;
  receipts: ReceiptsTable;
  ledgerEntries: LedgerEntriesTable;
  customerBalances: CustomerBalancesView;
  cashHandovers: CashHandoversTable;
  cashHandoverItems: CashHandoverItemsTable;
  cashAdjustments: CashAdjustmentsTable;
  idempotencyKeys: IdempotencyKeysTable;
  systemAlerts: SystemAlertsTable;
  jobRuns: JobRunsTable;
  visits: VisitsTable;
  interactions: InteractionsTable;
  followUpTasks: FollowUpTasksTable;
  syncOperations: SyncOperationsTable;
  importBatches: ImportBatchesTable;
  legacyStatementLines: LegacyStatementLinesTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type Customer = Selectable<CustomersTable>;
