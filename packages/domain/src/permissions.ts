/**
 * Role → permission matrix. Single source of truth for authorization rules.
 * The API enforces these on every request; frontends may use them only to hide UI.
 * See docs/BUSINESS_REQUIREMENTS.md §3.
 */
export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'AGENT'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'users:manage', // create / disable admin users
  'agents:read',
  'agents:manage',
  'areas:read',
  'areas:manage',
  'societies:read',
  'societies:manage',
  'customers:read:all',
  'customers:read:assigned',
  'customers:manage',
  'assignments:read',
  'assignments:manage',
  'settings:read',
  'settings:manage',
  'audit:read',
  'notifications:read:own',
  'import:manage',
  // Financial (Phase 3)
  'billing:read',
  'billing:manage', // subscriptions, rates, suspensions, manual invoices, billing runs, invoice cancellation
  'payments:record', // record a payment for a customer the caller may access
  'payments:read:all',
  'payments:verify', // confirm / fail pending UPI, bank, cheque payments
  'payments:reverse',
  'credits:manage', // discounts, adjustments, refunds, opening balances (up to the admin limit)
  'credits:approve-large', // above the admin limit
  'cash:submit', // agent cash handover
  'cash:manage', // verify handovers, cash adjustments, all agents' cash
  'reconciliation:run',
  // Field operations & reporting (Phase 4)
  'visits:record', // record a visit for a customer the caller may access
  'interactions:manage', // calls, promises to pay, customer requests
  'followups:manage', // see/assign/complete anyone's follow-ups
  'dashboard:read',
  'reports:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ADMIN_PERMISSIONS: readonly Permission[] = [
  'agents:read',
  'agents:manage',
  'areas:read',
  'areas:manage',
  'societies:read',
  'societies:manage',
  'customers:read:all',
  'customers:manage',
  'assignments:read',
  'assignments:manage',
  'settings:read',
  'audit:read',
  'notifications:read:own',
  'billing:read',
  'billing:manage',
  'payments:record',
  'payments:read:all',
  'payments:verify',
  'payments:reverse',
  'credits:manage',
  'cash:manage',
  'reconciliation:run',
  'visits:record',
  'interactions:manage',
  'followups:manage',
  'dashboard:read',
  'reports:read',
];

const AGENT_PERMISSIONS: readonly Permission[] = [
  'customers:read:assigned',
  'societies:read',
  'notifications:read:own',
  'payments:record',
  'cash:submit',
  'visits:record',
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  SUPER_ADMIN: new Set<Permission>(PERMISSIONS),
  ADMIN: new Set<Permission>(ADMIN_PERMISSIONS),
  AGENT: new Set<Permission>(AGENT_PERMISSIONS),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** True when the role sees every customer (no assignment check needed). */
export function canReadAllCustomers(role: Role): boolean {
  return hasPermission(role, 'customers:read:all');
}
