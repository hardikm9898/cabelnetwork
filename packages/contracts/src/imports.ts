import { z } from 'zod';
import { isBusinessDate } from '@cablenet/domain';
import { paginationQuery } from './common';

/**
 * Excel workbook import (EXCEL_MIGRATION_MAPPING §6–7): upload → analyse → correct → dry run
 * (rolled back) → approve the exact dry-run result → commit.
 */

export const IMPORT_OPTIONS = ['FULL_HISTORY', 'OPENING_BALANCE'] as const;
export type ImportOptionName = (typeof IMPORT_OPTIONS)[number];

export const CORRECTABLE_FIELDS = ['name', 'mobile', 'addressLine', 'society', 'monthlyRate'] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

export const importCorrectionRequest = z.object({
  customerCode: z.string().trim().min(1).max(20),
  field: z.enum(CORRECTABLE_FIELDS),
  /** null removes the correction (back to the workbook value). For monthlyRate, "" keeps "needs decision". */
  value: z.string().trim().max(500).nullable(),
});
export type ImportCorrectionRequest = z.infer<typeof importCorrectionRequest>;

export const importDryRunRequest = z.object({
  option: z.enum(IMPORT_OPTIONS),
  /** First day the new system bills (first of a month). Excel months before it are history. */
  cutoverDate: z.string().refine((v) => isBusinessDate(v) && v.endsWith('-01'), 'Choose the first day of a month'),
});
export type ImportDryRunRequest = z.infer<typeof importDryRunRequest>;

export const importApproveRequest = z.object({
  dryRunHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The approver confirms they checked the reconciliation report. */
  confirm: z.literal(true),
});

export const listImportsQuery = paginationQuery;

export type IssueSeverity = 'error' | 'warning';

export interface ImportIssue {
  /** D-1 … D-11 (EXCEL_MIGRATION_MAPPING §4) or an X-/V- code for checks done at import. */
  code: string;
  severity: IssueSeverity;
  customerCode: string | null;
  sheet: string | null;
  row: number | null;
  message: string;
}

export interface ReconciliationLine {
  key: string;
  check: string;
  excel: string;
  system: string;
  ok: boolean;
}

export interface ImportReport {
  option: ImportOptionName;
  cutoverDate: string;
  historyYear: number;
  monthsImported: string[];
  lines: ReconciliationLine[];
  perCustomer: { equal: number; total: number; mismatches: { customerCode: string; excel: string; system: string }[] };
  created: { customers: number; societies: number; subscriptions: number; invoices: number; payments: number; openingBalances: number; legacyLines: number; pendingDecision: number };
  blockingIssues: ImportIssue[];
  ok: boolean;
}
