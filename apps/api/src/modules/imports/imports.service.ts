import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { CorrectableField, ImportCorrectionRequest, ImportDryRunRequest, ImportIssue, ImportOptionName, ImportReport, ReconciliationLine } from '@cablenet/contracts';
import { addDays, addMonths, businessDateOf, fromPaise, Paise, periodLabel, toPaise } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { Page } from '../../common/http';
import type { AuthUser } from '../../common/request-context';
import { AssignmentsService } from '../assignments/assignments.service';
import { AuditService } from '../core/audit.service';
import { SettingsService } from '../core/settings.service';
import { LedgerService } from '../finance/ledger.service';
import { MONTHS, normaliseMobile, parseWorkbook, ParsedCustomer, ParsedWorkbook, recompute, crossCheck, StatementLine } from './workbook';

type Corrections = Record<string, Partial<Record<CorrectableField, string>>>;

/** A customer as it will be imported: workbook values with the office's corrections applied. */
interface Effective extends ParsedCustomer {
  /** Rate Excel used for the past (text/blank = none). */
  historyRate: string | null;
  /** Rate the new system bills from cutover (corrected or Excel's); null = waiting for a decision (Q1). */
  futureRate: string | null;
  corrected: CorrectableField[];
}

/** Thrown inside the dry-run transaction to roll everything back while keeping the report. */
class DryRunRollback extends Error {
  constructor(readonly report: ImportReport) {
    super('dry run');
  }
}

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const ym = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;
const first = (year: number, month: number) => `${ym(year, month)}-01`;
const chunks = <T>(xs: T[], n = 500) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const sum = (xs: Paise[]) => xs.reduce((s, x) => s + x, 0n);
const OPTION_LABEL: Record<ImportOptionName, string> = { FULL_HISTORY: 'Option A — full history', OPENING_BALANCE: 'Option B — opening balance' };

/**
 * Excel workbook import (EXCEL_MIGRATION_MAPPING §6–7; FINANCIAL_LOGIC never bypassed: money goes
 * through ledger entries and the normal FIFO allocation).
 *
 *   upload → analyse (parse + checks) → corrections → dry run (full import, rolled back, report)
 *   → approve (the exact dry-run hash) → commit (same import for real; must reproduce the hash).
 */
@Injectable()
export class ImportsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly assignments: AssignmentsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Upload / read
  // ---------------------------------------------------------------------------

  async upload(file: { originalname: string; buffer: Buffer; size: number }, actor: AuthUser) {
    if (!/\.xlsx$/i.test(file.originalname) || file.buffer.subarray(0, 2).toString() !== 'PK') {
      throw unprocessable('NOT_XLSX', 'Upload the workbook as an .xlsx file');
    }
    let parsed: ParsedWorkbook;
    try {
      parsed = await parseWorkbook(file.buffer);
    } catch (e) {
      throw unprocessable('WORKBOOK_UNREADABLE', `The workbook could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const hash = sha256(file.buffer);
    // The same file again is refused, unless every customer it brought in was deleted since.
    const committed = await this.db
      .selectFrom('importBatches as b')
      .select('b.id')
      .where('b.fileSha256', '=', hash)
      .where('b.status', '=', 'COMMITTED')
      .where((eb) => eb.exists(eb.selectFrom('customers as c').select('c.id').whereRef('c.importBatchId', '=', 'b.id').where('c.deletedAt', 'is', null)))
      .executeTakeFirst();
    if (committed) throw conflict('ALREADY_IMPORTED', 'This exact workbook has already been imported');
    const batch = await this.db
      .insertInto('importBatches')
      .values({
        fileName: file.originalname,
        fileSha256: hash,
        fileSize: file.size,
        fileData: file.buffer,
        analysis: JSON.stringify(parsed),
        uploadedBy: actor.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(this.db, { action: 'import.uploaded', entityType: 'import_batch', entityId: batch.id, after: { fileName: file.originalname, sha256: hash, customers: parsed.customers.length } });
    return this.get(batch.id);
  }

  async list(page: number, pageSize: number) {
    const q = this.db.selectFrom('importBatches as b').innerJoin('users as u', 'u.id', 'b.uploadedBy');
    const [items, total] = await Promise.all([
      q
        .select(['b.id', 'b.fileName', 'b.fileSize', 'b.status', 'b.option', 'b.cutoverDate', 'b.uploadedAt', 'b.committedAt', 'u.fullName as uploadedByName'])
        .orderBy('b.uploadedAt', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute(),
      q.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(items, { page, pageSize, total: Number(total.n) });
  }

  private async load(db: Database, id: string, lock = false) {
    let q = db.selectFrom('importBatches').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    const b = await q.executeTakeFirst();
    if (!b) throw notFound('IMPORT_NOT_FOUND', 'Import not found');
    return { ...b, analysis: b.analysis as ParsedWorkbook, corrections: (b.corrections ?? {}) as Corrections };
  }

  /** Batch with the customers as they will be imported and every check (workbook + database). */
  async get(id: string) {
    const b = await this.load(this.db, id);
    const eff = this.effective(b.analysis, b.corrections);
    const issues = [...b.analysis.issues, ...this.validateCustomers(eff, b.analysis), ...(await this.validateAgainstDatabase(this.db, eff))];
    const users = await this.db
      .selectFrom('users')
      .select(['id', 'fullName'])
      .where('id', 'in', [b.uploadedBy, b.dryRunBy, b.approvedBy, b.committedBy].filter((x): x is string => !!x))
      .execute();
    const name = (uid: string | null) => users.find((u) => u.id === uid)?.fullName ?? null;
    const p = b.analysis;
    const billable = eff.filter((c) => c.futureRate && toPaise(c.futureRate) > 0n);
    const lastMonth = Math.max(0, ...p.monthsFound.filter((m) => Object.values(p.months[m] ?? {}).some((e) => e.received && toPaise(e.received) > 0n)));
    return {
      id: b.id,
      fileName: b.fileName,
      fileSize: b.fileSize,
      fileSha256: b.fileSha256,
      status: b.status,
      option: b.option,
      cutoverDate: b.cutoverDate,
      uploadedAt: b.uploadedAt,
      uploadedByName: name(b.uploadedBy),
      dryRunAt: b.dryRunAt,
      dryRunByName: name(b.dryRunBy),
      dryRunHash: b.dryRunHash,
      approvedAt: b.approvedAt,
      approvedByName: name(b.approvedBy),
      committedAt: b.committedAt,
      committedByName: name(b.committedBy),
      report: (b.commitReport ?? b.dryRunReport ?? null) as ImportReport | null,
      summary: {
        historyYear: p.historyYear,
        monthsFound: p.monthsFound,
        lastMonthWithPayments: lastMonth,
        suggestedCutover: lastMonth
          ? lastMonth === 12
            ? first(p.historyYear + 1, 1)
            : first(p.historyYear, lastMonth + 1)
          : p.monthsFound.length === 0
            ? addMonths(`${businessDateOf(new Date()).slice(0, 7)}-01`, 1) // customer list only: next month
            : null,
        customers: eff.length,
        billable: billable.length,
        monthlyTotal: fromPaise(sum(billable.map((c) => toPaise(c.futureRate!)))),
        pendingDecision: eff.filter((c) => !c.futureRate).length,
        collections: fromPaise(sum(eff.flatMap((c) => p.monthsFound.map((m) => toPaise(p.months[m]?.[c.code]?.received ?? '0'))))),
        perMonth: p.monthsFound.map((m) => {
          const rows = Object.values(p.months[m] ?? {}).filter((e) => e.received && toPaise(e.received) > 0n);
          return { month: m, payments: rows.length, amount: fromPaise(sum(rows.map((e) => toPaise(e.received!)))) };
        }),
        errors: issues.filter((i) => i.severity === 'error').length,
        warnings: issues.filter((i) => i.severity === 'warning').length,
      },
      customers: eff.map((c) => ({
        row: c.row,
        code: c.code,
        name: c.name,
        addressLine: c.addressLine,
        mobile: c.mobile,
        mobileValid: c.mobileValid,
        rateRaw: c.rateRaw,
        rate: c.futureRate,
        society: c.society,
        stb: c.stb,
        corrected: c.corrected,
      })),
      corrections: b.corrections,
      issues,
    };
  }

  /**
   * Parallel run (DEVELOPMENT_ROADMAP Phase 8 gate): compares a workbook kept alongside the system
   * with the system's books for one month — each customer's closing balance and the month's
   * collections. Read-only; the workbook is not stored.
   */
  async compare(file: { originalname: string; buffer: Buffer }, month: string, actor: AuthUser) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw unprocessable('VALIDATION_FAILED', 'Month must be YYYY-MM');
    if (!/\.xlsx$/i.test(file.originalname) || file.buffer.subarray(0, 2).toString() !== 'PK') throw unprocessable('NOT_XLSX', 'Upload the workbook as an .xlsx file');
    let p: ParsedWorkbook;
    try {
      p = await parseWorkbook(file.buffer);
    } catch (e) {
      throw unprocessable('WORKBOOK_UNREADABLE', `The workbook could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const [y, m] = month.split('-').map(Number) as [number, number];
    if (y !== p.historyYear) throw unprocessable('WRONG_YEAR', `This workbook is for ${p.historyYear}`);
    if (!p.monthsFound.includes(m)) throw unprocessable('MONTH_NOT_IN_WORKBOOK', `The workbook has no ${MONTHS[m - 1]} sheet`);
    const monthStart = first(y, m);
    const monthEnd = addDays(addMonths(monthStart, 1), -1);

    const excel = new Map(
      p.customers.map((c) => {
        const l = recompute(c.rate, p.months, c.code, m)[m - 1]!;
        return [c.code, { name: c.name, balance: toPaise(l.amountDue) - toPaise(l.closingAdvance), collected: toPaise(l.received) }];
      }),
    );
    const sys = await sql<{ code: string; name: string; balance: string; collected: string }>`
      SELECT c.customer_code AS code, c.name,
             coalesce((SELECT sum(amount) FROM ledger_entries l WHERE l.customer_id = c.id AND l.entry_date <= ${monthEnd}::date), 0) AS balance,
             coalesce((SELECT sum(amount) FROM payments x WHERE x.customer_id = c.id AND x.status = 'CONFIRMED'
                        AND x.payment_date BETWEEN ${monthStart}::date AND ${monthEnd}::date), 0) AS collected
      FROM customers c WHERE c.deleted_at IS NULL
    `.execute(this.db);
    const system = new Map(sys.rows.map((r) => [r.code, { name: r.name, balance: toPaise(r.balance), collected: toPaise(r.collected) }]));

    const mismatches: { customerCode: string; name: string; excelBalance: string; systemBalance: string; excelCollected: string; systemCollected: string }[] = [];
    let equal = 0;
    for (const [code, e] of excel) {
      const s = system.get(code);
      if (!s) continue;
      if (s.balance === e.balance && s.collected === e.collected) equal++;
      else mismatches.push({ customerCode: code, name: e.name, excelBalance: fromPaise(e.balance), systemBalance: fromPaise(s.balance), excelCollected: fromPaise(e.collected), systemCollected: fromPaise(s.collected) });
    }
    const onlyExcel = [...excel.keys()].filter((c) => !system.has(c));
    const onlySystem = [...system.entries()].filter(([c]) => !excel.has(c)).map(([c, s]) => ({ customerCode: c, name: s.name }));
    const both = [...excel.keys()].filter((c) => system.has(c));
    const totals = {
      excelCollected: fromPaise(sum(both.map((c) => excel.get(c)!.collected))),
      systemCollected: fromPaise(sum(both.map((c) => system.get(c)!.collected))),
      excelOutstanding: fromPaise(sum(both.map((c) => excel.get(c)!.balance).filter((b) => b > 0n))),
      systemOutstanding: fromPaise(sum(both.map((c) => system.get(c)!.balance).filter((b) => b > 0n))),
    };
    await this.audit.record(this.db, { action: 'import.compared', entityType: 'import_batch', entityId: null, after: { month, compared: both.length, mismatches: mismatches.length } });
    return {
      month,
      compared: both.length,
      equal,
      mismatches,
      onlyInWorkbook: onlyExcel,
      onlyInSystem: onlySystem.slice(0, 200),
      totals,
      ok: mismatches.length === 0 && onlyExcel.length === 0,
    };
  }

  /** Read-only Excel statement of an imported customer (both options). */
  async legacyStatement(customerId: string) {
    return this.db
      .selectFrom('legacyStatementLines')
      .select(['month', 'rateRaw', 'rate', 'opening', 'received', 'feeAdjusted', 'closingAdvance', 'amountDue', 'paymentDate', 'notes'])
      .where('customerId', '=', customerId)
      .orderBy('month')
      .execute();
  }

  async pendingDecisions() {
    return this.db
      .selectFrom('customers as c')
      .innerJoin('societies as s', 's.id', 'c.societyId')
      .select(['c.id', 'c.customerCode', 'c.name', 's.name as society', 'c.pendingDecision'])
      .where('c.pendingDecision', 'is not', null)
      .where('c.deletedAt', 'is', null)
      .orderBy('c.customerCode')
      .execute();
  }

  // ---------------------------------------------------------------------------
  // Corrections, dry run, approval, commit
  // ---------------------------------------------------------------------------

  private assertEditable(status: string) {
    if (status === 'COMMITTED') throw conflict('IMPORT_COMMITTED', 'This import is already committed');
    if (status === 'DISCARDED') throw conflict('IMPORT_DISCARDED', 'This import was discarded');
  }

  async correct(id: string, input: ImportCorrectionRequest) {
    return this.db.transaction().execute(async (trx) => {
      const b = await this.load(trx, id, true);
      this.assertEditable(b.status);
      if (!b.analysis.customers.some((c) => c.code === input.customerCode)) throw notFound('CUSTOMER_NOT_IN_WORKBOOK', `Customer ${input.customerCode} is not in this workbook`);
      if (input.field === 'monthlyRate' && input.value && !/^\d{1,8}(\.\d{1,2})?$/.test(input.value)) {
        throw unprocessable('VALIDATION_FAILED', 'Monthly rate must be an amount like 300 or 300.00 (or empty to leave it undecided)');
      }
      if ((input.field === 'name' || input.field === 'addressLine' || input.field === 'society') && input.value === '') {
        throw unprocessable('VALIDATION_FAILED', 'This field cannot be empty');
      }
      const corr: Corrections = structuredClone(b.corrections);
      const before = corr[input.customerCode]?.[input.field] ?? null;
      corr[input.customerCode] ??= {};
      if (input.value === null) delete corr[input.customerCode]![input.field];
      else corr[input.customerCode]![input.field] = input.value;
      if (Object.keys(corr[input.customerCode]!).length === 0) delete corr[input.customerCode];
      // Any change invalidates an earlier dry run and approval.
      await trx
        .updateTable('importBatches')
        .set({ corrections: JSON.stringify(corr), status: 'ANALYSED', dryRunReport: null, dryRunHash: null, approvedHash: null, approvedAt: null, approvedBy: null })
        .where('id', '=', id)
        .execute();
      await this.audit.record(trx, { action: 'import.corrected', entityType: 'import_batch', entityId: id, before: { [input.field]: before }, after: { customerCode: input.customerCode, [input.field]: input.value } });
      return { ok: true };
    }).then(() => this.get(id));
  }

  async dryRun(id: string, input: ImportDryRunRequest, actor: AuthUser) {
    const b = await this.load(this.db, id);
    this.assertEditable(b.status);
    let report: ImportReport;
    try {
      await this.db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('cablenet.import', 7))`.execute(trx);
        const r = await this.execute(trx, b, input.option, input.cutoverDate, actor);
        throw new DryRunRollback(r);
      });
      throw new Error('unreachable');
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
      report = e.report;
    }
    const hash = this.hashOf(b, input.option, input.cutoverDate, report);
    await this.db
      .updateTable('importBatches')
      .set({
        status: report.ok ? 'DRY_RUN_OK' : 'DRY_RUN_FAILED',
        option: input.option,
        cutoverDate: input.cutoverDate,
        dryRunReport: JSON.stringify(report),
        dryRunHash: hash,
        dryRunAt: sql<Date>`now()`,
        dryRunBy: actor.id,
        approvedHash: null,
        approvedAt: null,
        approvedBy: null,
      })
      .where('id', '=', id)
      .execute();
    await this.audit.record(this.db, { action: 'import.dry_run', entityType: 'import_batch', entityId: id, after: { option: input.option, cutoverDate: input.cutoverDate, ok: report.ok, hash } });
    return this.get(id);
  }

  async approve(id: string, dryRunHash: string, actor: AuthUser) {
    await this.db.transaction().execute(async (trx) => {
      const b = await this.load(trx, id, true);
      if (b.status !== 'DRY_RUN_OK') throw conflict('IMPORT_NOT_READY', 'Run a dry run that reconciles before approving');
      if (b.dryRunHash !== dryRunHash) throw conflict('DRY_RUN_CHANGED', 'The dry run changed since you looked at it; check the new report');
      await trx.updateTable('importBatches').set({ status: 'APPROVED', approvedHash: dryRunHash, approvedAt: sql<Date>`now()`, approvedBy: actor.id }).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'import.approved', entityType: 'import_batch', entityId: id, after: { hash: dryRunHash } });
    });
    return this.get(id);
  }

  async commit(id: string, actor: AuthUser) {
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('cablenet.import', 7))`.execute(trx);
      const b = await this.load(trx, id, true);
      if (b.status === 'COMMITTED') throw conflict('IMPORT_COMMITTED', 'This import is already committed');
      if (b.status !== 'APPROVED' || !b.option || !b.cutoverDate || !b.approvedHash) throw conflict('IMPORT_NOT_APPROVED', 'Approve the dry run first');
      const report = await this.execute(trx, b, b.option, b.cutoverDate, actor);
      const hash = this.hashOf(b, b.option, b.cutoverDate, report);
      if (!report.ok || hash !== b.approvedHash) {
        // Something changed since the dry run (e.g. customers added): nothing is written.
        throw conflict('IMPORT_CHANGED', 'The result differs from the approved dry run; run the dry run again');
      }
      await trx
        .updateTable('importBatches')
        // The workbook bytes (all customer data) are no longer needed; the hash stays (review I-5).
        .set({ status: 'COMMITTED', committedAt: sql<Date>`now()`, committedBy: actor.id, commitReport: JSON.stringify(report), fileData: Buffer.alloc(0) })
        .where('id', '=', id)
        .execute();
      await this.audit.record(trx, { action: 'import.committed', entityType: 'import_batch', entityId: id, after: { option: b.option, cutoverDate: b.cutoverDate, created: report.created } });
    });
    return this.get(id);
  }

  async discard(id: string) {
    await this.db.transaction().execute(async (trx) => {
      const b = await this.load(trx, id, true);
      this.assertEditable(b.status);
      await trx.updateTable('importBatches').set({ status: 'DISCARDED', fileData: Buffer.alloc(0) }).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'import.discarded', entityType: 'import_batch', entityId: id });
    });
    return this.get(id);
  }

  private hashOf(b: { fileSha256: string; corrections: Corrections }, option: string, cutover: string, report: ImportReport) {
    return sha256(JSON.stringify({ file: b.fileSha256, corrections: b.corrections, option, cutover, report }));
  }

  // ---------------------------------------------------------------------------
  // Checks
  // ---------------------------------------------------------------------------

  private effective(p: ParsedWorkbook, corr: Corrections): Effective[] {
    return p.customers.map((c) => {
      const k = corr[c.code] ?? {};
      const corrected = Object.keys(k) as CorrectableField[];
      const mobile = k.mobile !== undefined ? normaliseMobile(k.mobile) : { mobile: c.mobile, valid: c.mobileValid };
      const futureRate = k.monthlyRate !== undefined ? (k.monthlyRate ? fromPaise(toPaise(k.monthlyRate)) : null) : c.rate;
      return {
        ...c,
        name: k.name ?? c.name,
        addressLine: k.addressLine ?? c.addressLine,
        society: k.society ?? c.society,
        mobileRaw: k.mobile ?? c.mobileRaw,
        mobile: mobile.mobile,
        mobileValid: mobile.valid,
        historyRate: c.rate,
        futureRate: futureRate && toPaise(futureRate) > 0n ? futureRate : null,
        corrected,
      };
    });
  }

  private validateCustomers(eff: Effective[], p: ParsedWorkbook): ImportIssue[] {
    const out: ImportIssue[] = [];
    const at = (c: Effective) => ({ customerCode: c.code, sheet: 'Customer List', row: c.row });
    const add = (code: string, severity: 'error' | 'warning', message: string, where: Partial<ImportIssue> = {}) =>
      out.push({ code, severity, customerCode: where.customerCode ?? null, sheet: where.sheet ?? null, row: where.row ?? null, message });

    const byCode = new Map<string, Effective[]>();
    const byStb = new Map<string, Effective[]>();
    const byMobile = new Map<string, Effective[]>();
    const byName = new Map<string, Effective[]>();
    for (const c of eff) {
      const push = <K>(m: Map<K, Effective[]>, k: K) => m.set(k, [...(m.get(k) ?? []), c]);
      push(byCode, c.code.toLowerCase());
      if (c.stb) push(byStb, c.stb.toUpperCase());
      if (c.mobile && c.mobileValid) push(byMobile, c.mobile);
      push(byName, c.name.toUpperCase());

      if (!/^[A-Za-z0-9-]{1,20}$/.test(c.code)) add('V-CODE', 'error', `Customer ID "${c.code}" is not a valid ID (letters, digits, up to 20)`, at(c));
      if (!c.name || c.name.length > 150) add('V-NAME', 'error', 'Name is missing or longer than 150 characters', at(c));
      if (!c.addressLine) add('V-ADDRESS', 'error', 'Address is missing', at(c));
      if (c.society.length > 120) add('V-SOCIETY', 'error', 'Society name is longer than 120 characters', at(c));
      if (!c.futureRate) {
        add(c.rateRaw ? 'D-1' : 'D-2', 'warning', `Monthly rate is "${c.rateRaw || 'blank'}": imported without billing and marked "needs decision" (Q1). Enter a rate to bill from cutover.`, at(c));
      } else if (c.corrected.includes('monthlyRate') && c.historyRate !== c.futureRate) {
        add('V-RATE', 'warning', `Rate ${c.futureRate} applies from cutover; Excel history keeps ${c.historyRate ?? 'no rate'}`, at(c));
      }
      if (c.mobileRaw && !c.mobileValid) add('D-3', 'warning', `Mobile "${c.mobileRaw}" is not a valid 10-digit number; kept and marked invalid`, at(c));
      if (!c.stb) add('V-STB', 'warning', 'No STB number; imported without a connection', at(c));
      else if (c.stb.length > 30) add('V-STB', 'error', 'STB number is longer than 30 characters', at(c));

      const lines = recompute(c.historyRate, p.months, c.code);
      for (const msg of crossCheck(lines, p.months, c.code)) add('X-CALC', 'warning', msg, { customerCode: c.code });
      for (const m of p.monthsFound) {
        const e = p.months[m]?.[c.code];
        if (!e) continue;
        const where = { customerCode: c.code, sheet: MONTHS[m - 1]!.replace(/^./, (x) => x.toUpperCase()), row: e.row };
        const paid = e.received ? toPaise(e.received) : 0n;
        if (e.paymentDate && paid === 0n) add('D-9', 'warning', `Payment date ${e.paymentDate} without an amount: not a payment`, where);
        if (paid > 0n && !e.paymentDate) add('V-NODATE', 'warning', 'Payment without a date: the 1st of the month is used', where);
        if (paid > 0n && e.paymentDate && e.paymentDate.slice(0, 7) !== ym(p.historyYear, m)) {
          add('V-DATEMONTH', 'warning', `Payment dated ${e.paymentDate} is typed in the ${where.sheet} sheet; kept as typed`, where);
        }
      }
    }
    for (const [, list] of byCode) if (list.length > 1) for (const c of list) add('V-DUPID', 'error', `Customer ID ${c.code} appears ${list.length} times`, at(c));
    for (const [stb, list] of byStb) if (list.length > 1) for (const c of list) add('V-DUPSTB', 'error', `STB ${stb} is on ${list.length} customers`, at(c));
    for (const [mobile, list] of byMobile) {
      if (list.length > 1) add('D-4', 'warning', `Mobile ${mobile} is on ${list.length} customers: ${list.map((c) => c.code).join(', ')}`, { customerCode: list[0]!.code });
    }
    for (const [, list] of byName) {
      if (list.length > 1) add('D-5', 'warning', `Same name on ${list.length} customers: ${list.map((c) => c.code).join(', ')} (kept as separate customers)`, { customerCode: list[0]!.code });
    }
    const known = new Set(eff.map((c) => c.code));
    for (const m of p.monthsFound) {
      for (const [code, e] of Object.entries(p.months[m] ?? {})) {
        if (!known.has(code) && e.received && toPaise(e.received) > 0n) {
          add('V-UNKNOWN', 'error', `Payment for customer ${code}, who is not in the Customer List`, { customerCode: code, sheet: MONTHS[m - 1]!, row: e.row });
        }
      }
    }
    return out;
  }

  private async validateAgainstDatabase(db: Database, eff: Effective[]): Promise<ImportIssue[]> {
    if (eff.length === 0) return [];
    const [codes, stbs] = await Promise.all([
      db
        .selectFrom('customers')
        .select('customerCode')
        .where(sql<boolean>`lower(customer_code) = ANY(${eff.map((c) => c.code.toLowerCase())}::text[])`)
        .where('deletedAt', 'is', null)
        .execute(),
      db
        .selectFrom('customerConnections')
        .select('stbNumber')
        .where('activeTo', 'is', null)
        .where(sql<boolean>`upper(stb_number) = ANY(${eff.filter((c) => c.stb).map((c) => c.stb!.toUpperCase())}::text[])`)
        .execute(),
    ]);
    const out: ImportIssue[] = [];
    for (const c of codes) out.push({ code: 'V-EXISTS', severity: 'error', customerCode: c.customerCode, sheet: null, row: null, message: `Customer ${c.customerCode} already exists in the system` });
    for (const s of stbs) out.push({ code: 'V-EXISTS', severity: 'error', customerCode: null, sheet: null, row: null, message: `STB ${s.stbNumber} is already active on a customer in the system` });
    return out;
  }

  // ---------------------------------------------------------------------------
  // The import itself (dry run and commit run exactly this)
  // ---------------------------------------------------------------------------

  private async execute(trx: Database, b: Awaited<ReturnType<ImportsService['load']>>, option: ImportOptionName, cutover: string, actor: AuthUser): Promise<ImportReport> {
    const p = b.analysis;
    const year = p.historyYear;
    const eff = this.effective(p, b.corrections);
    const issues = [...p.issues, ...this.validateCustomers(eff, p), ...(await this.validateAgainstDatabase(trx, eff))];

    // Months before cutover are history; the new system bills from cutover.
    const historyMonths = p.monthsFound.filter((m) => first(year, m) < cutover);
    const yearEnd = first(year + 1, 1);
    // A plain customer list has no history: any cutover month works, balances start at zero.
    const customersOnly = p.monthsFound.length === 0;
    if (customersOnly && option === 'FULL_HISTORY') {
      issues.push({ code: 'V-OPTION', severity: 'error', customerCode: null, sheet: null, row: null, message: 'This workbook has no month sheets (no payment history): choose Option B (opening balance)' });
    }
    if (!customersOnly && cutover > yearEnd) {
      issues.push({ code: 'V-CUTOVER', severity: 'error', customerCode: null, sheet: null, row: null, message: `The workbook covers ${year} only; choose a cutover on or before ${yearEnd}` });
    }
    if (!customersOnly && cutover <= first(year, 1)) {
      issues.push({ code: 'V-CUTOVER', severity: 'error', customerCode: null, sheet: null, row: null, message: `Cutover must be after the start of the workbook (${first(year, 1)})` });
    }
    const missingHistory = customersOnly ? [] : MONTHS.map((_, i) => i + 1).filter((m) => first(year, m) < cutover && !p.monthsFound.includes(m));
    if (missingHistory.length) {
      issues.push({ code: 'V-MONTHS', severity: 'error', customerCode: null, sheet: null, row: null, message: `Month sheets needed before cutover are missing: ${missingHistory.map((m) => MONTHS[m - 1]).join(', ')}` });
    }
    for (const m of p.monthsFound.filter((x) => !historyMonths.includes(x))) {
      const paid = Object.entries(p.months[m] ?? {}).filter(([, e]) => e.received && toPaise(e.received) > 0n);
      if (paid.length) {
        issues.push({ code: 'V-AFTERCUTOVER', severity: 'error', customerCode: null, sheet: MONTHS[m - 1]!, row: null, message: `${paid.length} payments are typed in ${MONTHS[m - 1]}, on or after cutover; choose a later cutover` });
      }
    }

    const excel = new Map(eff.map((c) => [c.code, recompute(c.historyRate, p.months, c.code)]));
    const lastHistory = historyMonths.length ? Math.max(...historyMonths) : 0;
    const closing = (code: string): Paise => {
      if (!lastHistory) return 0n;
      const l = excel.get(code)![lastHistory - 1]!;
      return toPaise(l.amountDue) - toPaise(l.closingAdvance); // + owes / − advance
    };

    const blocking = issues.filter((i) => i.severity === 'error');
    const created = { customers: 0, societies: 0, subscriptions: 0, invoices: 0, payments: 0, openingBalances: 0, legacyLines: 0, pendingDecision: 0 };
    if (blocking.length === 0) {
      await this.write(trx, b.id, eff, p, excel, historyMonths, option, cutover, closing, actor, created);
    }
    return this.report(trx, b.id, eff, p, excel, historyMonths, option, cutover, closing, created, blocking);
  }

  private async write(
    trx: Database,
    batchId: string,
    eff: Effective[],
    p: ParsedWorkbook,
    excel: Map<string, StatementLine[]>,
    historyMonths: number[],
    option: ImportOptionName,
    cutover: string,
    closing: (code: string) => Paise,
    actor: AuthUser,
    created: ImportReport['created'],
  ) {
    const year = p.historyYear;
    const dueDays = (await this.settings.get('billing.defaults', trx)).dueDays;
    const reason = `Excel import (${OPTION_LABEL[option]}, cutover ${cutover})`;

    // Societies: reuse by name (or the exact Excel spelling), otherwise create with the typed name.
    const names = [...new Set(eff.map((c) => c.society))];
    const existing = await trx
      .selectFrom('societies')
      .select(['id', 'name', 'legacyName'])
      .where(sql<boolean>`(lower(name) = ANY(${names.map((n) => n.toLowerCase())}::text[]) OR lower(legacy_name) = ANY(${names.map((n) => n.toLowerCase())}::text[])) AND deleted_at IS NULL`)
      .execute();
    const societyId = new Map<string, string>();
    for (const n of names) {
      const hit = existing.find((s) => s.name.toLowerCase() === n.toLowerCase() || s.legacyName?.toLowerCase() === n.toLowerCase());
      if (hit) societyId.set(n, hit.id);
      else {
        const s = await trx.insertInto('societies').values({ name: n, legacyName: n, createdBy: actor.id, updatedBy: actor.id }).returning('id').executeTakeFirstOrThrow();
        societyId.set(n, s.id);
        created.societies++;
      }
    }

    // Customers and connections.
    const ids = new Map<string, string>();
    for (const part of chunks(eff)) {
      const rows = await trx
        .insertInto('customers')
        .values(
          part.map((c) => ({
            customerCode: c.code,
            name: c.name,
            mobile: c.mobile,
            mobileValid: c.mobileValid,
            addressLine: c.addressLine,
            societyId: societyId.get(c.society)!,
            status: 'ACTIVE' as const,
            notes: c.notes,
            importBatchId: batchId,
            pendingDecision: c.futureRate ? null : `Excel rate "${c.rateRaw || 'blank'}": choose the plan before billing (Q1)`,
            createdBy: actor.id,
            updatedBy: actor.id,
          })),
        )
        .returning(['id', 'customerCode'])
        .execute();
      for (const r of rows) ids.set(r.customerCode, r.id);
    }
    created.customers = ids.size;
    created.pendingDecision = eff.filter((c) => !c.futureRate).length;
    const startOfHistory = first(year, 1);
    const withStb = eff.filter((c) => c.stb);
    for (const part of chunks(withStb)) {
      await trx
        .insertInto('customerConnections')
        .values(part.map((c) => ({ customerId: ids.get(c.code)!, stbNumber: c.stb!, mqNumber: c.mq, activeFrom: option === 'FULL_HISTORY' ? startOfHistory : cutover, reason: 'Imported from Excel', createdBy: actor.id })))
        .execute();
    }
    // Agents: customers in societies whose area already has an owner get that agent.
    await this.assignments.applyAreaDefault(trx, [...ids.values()], actor.id, reason);

    // Subscriptions (monthly, advance billing on the 1st: Q4/Q6 defaults). The scheduler bills from cutover.
    const subId = new Map<string, string>();
    for (const c of eff) {
      const hist = option === 'FULL_HISTORY' && c.historyRate && toPaise(c.historyRate) > 0n && historyMonths.length > 0;
      if (!hist && !c.futureRate) continue;
      const start = hist ? startOfHistory : cutover;
      const sub = await trx
        .insertInto('customerSubscriptions')
        .values({
          customerId: ids.get(c.code)!,
          startDate: start,
          billingMode: 'AUTO',
          billingIntervalMonths: 1,
          billingAnchorDay: 1,
          billingTiming: 'ADVANCE',
          dueDays,
          nextPeriodStart: cutover,
          notes: 'Imported from Excel',
          createdBy: actor.id,
          updatedBy: actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      subId.set(c.code, sub.id);
      created.subscriptions++;
      const rates: { effectiveFrom: string; monthlyRate: string; reason: string }[] = [];
      if (hist) rates.push({ effectiveFrom: start, monthlyRate: c.historyRate!, reason: 'Rate in the Excel workbook' });
      if (c.futureRate && (!hist || c.futureRate !== c.historyRate)) rates.push({ effectiveFrom: cutover, monthlyRate: c.futureRate, reason: hist ? 'Rate corrected during import' : 'Rate from the Excel workbook' });
      if (!c.futureRate && hist) {
        // History billed, but no rate going forward: stop billing at cutover until the office decides.
        await trx.updateTable('customerSubscriptions').set({ status: 'ENDED', endDate: addDays(cutover, -1) }).where('id', '=', sub.id).execute();
      }
      await trx.insertInto('subscriptionRates').values(rates.map((r) => ({ ...r, subscriptionId: sub.id, createdBy: actor.id }))).execute();
    }

    const ledgerRows: { customerId: string; entryDate: string; type: 'CHARGE' | 'PAYMENT' | 'OPENING_BALANCE'; amount: string; invoiceId?: string; paymentId?: string; creditNoteId?: string; description: string; createdBy: string }[] = [];

    if (option === 'FULL_HISTORY') {
      // Bills for every history month at the rate Excel used, then the payments typed in Excel.
      for (const c of eff) {
        if (!c.historyRate || toPaise(c.historyRate) <= 0n || !subId.has(c.code)) continue;
        const customerId = ids.get(c.code)!;
        const invoices = historyMonths.map((m) => {
          const start = first(year, m);
          const end = addDays(addMonths(start, 1), -1);
          return {
            invoiceNumber: `XL-${c.code}-${ym(year, m)}`,
            kind: 'SUBSCRIPTION' as const,
            customerId,
            subscriptionId: subId.get(c.code)!,
            periodStart: start,
            periodEnd: end,
            billingDate: start,
            dueDate: addDays(start, dueDays),
            subtotal: c.historyRate!,
            total: c.historyRate!,
            status: 'UNPAID' as const,
            description: `Cable TV subscription ${periodLabel(start, end)} (from Excel)`,
            source: 'IMPORT' as const,
            externalRef: `XL:${c.code}:${ym(year, m)}`,
            createdBy: actor.id,
          };
        });
        if (invoices.length === 0) continue;
        const rows = await trx.insertInto('invoices').values(invoices).returning(['id', 'periodStart', 'periodEnd', 'invoiceNumber']).execute();
        await trx
          .insertInto('invoiceItems')
          .values(rows.map((r) => ({ invoiceId: r.id, itemType: 'SUBSCRIPTION', description: `Subscription ${periodLabel(r.periodStart!, r.periodEnd!)}`, months: 1, unitRate: c.historyRate!, amount: c.historyRate!, periodStart: r.periodStart, periodEnd: r.periodEnd })))
          .execute();
        for (const r of rows) {
          ledgerRows.push({ customerId, entryDate: r.periodStart!, type: 'CHARGE', amount: c.historyRate!, invoiceId: r.id, description: `Subscription ${periodLabel(r.periodStart!, r.periodEnd!)} (${r.invoiceNumber}, from Excel)`, createdBy: actor.id });
        }
        created.invoices += rows.length;
      }
      for (const c of eff) {
        const customerId = ids.get(c.code)!;
        const payments = historyMonths
          .map((m) => ({ m, e: p.months[m]?.[c.code] }))
          .filter(({ e }) => e?.received && toPaise(e.received) > 0n)
          .map(({ m, e }) => ({
            clientTxnId: randomUUID(),
            customerId,
            amount: e!.received!,
            paymentDate: e!.paymentDate ?? first(year, m),
            mode: 'LEGACY_UNKNOWN' as const,
            source: 'IMPORT' as const,
            status: 'CONFIRMED' as const,
            recordedBy: actor.id,
            externalRef: `XL:${c.code}:${ym(year, m)}`,
            notes: e!.notes,
          }));
        if (payments.length === 0) continue;
        const rows = await trx.insertInto('payments').values(payments).returning(['id', 'amount', 'paymentDate', 'externalRef']).execute();
        for (const r of rows) {
          ledgerRows.push({ customerId, entryDate: r.paymentDate, type: 'PAYMENT', amount: fromPaise(-toPaise(r.amount)), paymentId: r.id, description: `Payment from Excel (${r.externalRef})`, createdBy: actor.id });
        }
        created.payments += rows.length;
      }
    } else {
      // Opening balance at cutover = Excel closing balance of the last history month.
      const asOf = addDays(cutover, -1);
      for (const c of eff) {
        const bal = closing(c.code);
        if (bal === 0n) continue;
        const customerId = ids.get(c.code)!;
        if (bal > 0n) {
          const inv = await trx
            .insertInto('invoices')
            .values({ invoiceNumber: `XL-OPEN-${c.code}`, kind: 'OPENING_BALANCE', customerId, billingDate: asOf, dueDate: asOf, subtotal: fromPaise(bal), total: fromPaise(bal), status: 'UNPAID', description: 'Balance brought forward from Excel', source: 'IMPORT', externalRef: `XL:${c.code}:OPENING`, createdBy: actor.id })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx.insertInto('invoiceItems').values({ invoiceId: inv.id, itemType: 'OPENING_BALANCE', description: 'Balance brought forward', amount: fromPaise(bal) }).execute();
          ledgerRows.push({ customerId, entryDate: asOf, type: 'OPENING_BALANCE', amount: fromPaise(bal), invoiceId: inv.id, description: `Opening balance due from Excel (XL-OPEN-${c.code})`, createdBy: actor.id });
        } else {
          const cn = await trx
            .insertInto('creditNotes')
            .values({ creditNumber: `XL-OPEN-${c.code}`, customerId, kind: 'OPENING_ADVANCE', amount: fromPaise(-bal), creditDate: asOf, reason: 'Advance brought forward from Excel', approvedBy: actor.id, externalRef: `XL:${c.code}:OPENING` })
            .returning('id')
            .executeTakeFirstOrThrow();
          ledgerRows.push({ customerId, entryDate: asOf, type: 'OPENING_BALANCE', amount: fromPaise(bal), creditNoteId: cn.id, description: `Opening advance from Excel (XL-OPEN-${c.code})`, createdBy: actor.id });
        }
        created.openingBalances++;
      }
    }

    for (const part of chunks(ledgerRows)) await trx.insertInto('ledgerEntries').values(part).execute();
    // Oldest-first allocation, exactly as for live payments.
    const touched = new Set(ledgerRows.map((r) => r.customerId));
    for (const customerId of touched) await this.ledger.allocate(trx, customerId, actor.id);

    // The Excel month grid, read-only, for every customer (both options).
    const legacy = eff.flatMap((c) =>
      excel
        .get(c.code)!
        .filter((l) => historyMonths.includes(l.month))
        .map((l) => ({
          customerId: ids.get(c.code)!,
          importBatchId: batchId,
          month: first(year, l.month),
          rateRaw: c.rateRaw,
          rate: l.rate,
          opening: l.opening,
          received: l.received,
          feeAdjusted: l.feeAdjusted,
          closingAdvance: l.closingAdvance,
          amountDue: l.amountDue,
          paymentDate: l.paymentDate,
          notes: l.notes,
        })),
    );
    for (const part of chunks(legacy)) await trx.insertInto('legacyStatementLines').values(part).execute();
    created.legacyLines = legacy.length;

    for (const part of chunks(eff, 200)) {
      await trx
        .insertInto('auditLogs')
        .values(part.map((c) => ({ actorUserId: actor.id, actorRole: actor.role, action: 'customer.imported', entityType: 'customer', entityId: ids.get(c.code)!, after: JSON.stringify({ customerCode: c.code, batchId, option }) })))
        .execute();
    }
  }

  private async report(
    trx: Database,
    batchId: string,
    eff: Effective[],
    p: ParsedWorkbook,
    excel: Map<string, StatementLine[]>,
    historyMonths: number[],
    option: ImportOptionName,
    cutover: string,
    closing: (code: string) => Paise,
    created: ImportReport['created'],
    blocking: ImportIssue[],
  ): Promise<ImportReport> {
    const year = p.historyYear;
    const inr = (x: Paise) => fromPaise(x);
    const excelCollections = sum(eff.flatMap((c) => excel.get(c.code)!.filter((l) => historyMonths.includes(l.month)).map((l) => toPaise(l.received))));
    const excelClosing = eff.map((c) => ({ code: c.code, bal: closing(c.code) }));
    const billable = eff.filter((c) => c.futureRate);

    // System side, read back from the database inside the same transaction.
    const sys = await sql<{ customers: string; subs: string; rates: string; paid: string; legacy: string }>`
      SELECT
        (SELECT count(*) FROM customers WHERE import_batch_id = ${batchId}::uuid) AS customers,
        (SELECT count(*) FROM customer_subscriptions s JOIN customers c ON c.id = s.customer_id
          WHERE c.import_batch_id = ${batchId}::uuid AND (s.end_date IS NULL OR s.end_date >= ${cutover}::date)) AS subs,
        (SELECT coalesce(sum(r.monthly_rate), 0) FROM customer_subscriptions s JOIN customers c ON c.id = s.customer_id
          JOIN LATERAL (SELECT monthly_rate FROM subscription_rates WHERE subscription_id = s.id AND effective_from <= ${cutover}::date
                        ORDER BY effective_from DESC LIMIT 1) r ON TRUE
          WHERE c.import_batch_id = ${batchId}::uuid AND (s.end_date IS NULL OR s.end_date >= ${cutover}::date)) AS rates,
        (SELECT coalesce(sum(p.amount), 0) FROM payments p JOIN customers c ON c.id = p.customer_id
          WHERE c.import_batch_id = ${batchId}::uuid AND p.source = 'IMPORT') AS paid,
        (SELECT coalesce(sum(received), 0) FROM legacy_statement_lines WHERE import_batch_id = ${batchId}::uuid) AS legacy
    `.execute(trx);
    const s = sys.rows[0]!;
    const balances = await sql<{ code: string; bal: string }>`
      SELECT c.customer_code AS code, coalesce(sum(l.amount), 0) AS bal
      FROM customers c LEFT JOIN ledger_entries l ON l.customer_id = c.id
      WHERE c.import_batch_id = ${batchId}::uuid GROUP BY c.customer_code
    `.execute(trx);
    const sysBal = new Map(balances.rows.map((r) => [r.code, toPaise(r.bal)]));
    const written = blocking.length === 0;

    const sysOutstanding = sum([...sysBal.values()].filter((x) => x > 0n));
    const sysAdvance = sum([...sysBal.values()].filter((x) => x < 0n).map((x) => -x));
    const lines: ReconciliationLine[] = [
      { key: 'customers', check: 'Customers with an ID', excel: String(eff.length), system: s.customers, ok: written && Number(s.customers) === eff.length },
      { key: 'billable', check: 'Customers billed from cutover', excel: String(billable.length), system: s.subs, ok: written && Number(s.subs) === billable.length },
      { key: 'monthly', check: 'Monthly billing total', excel: inr(sum(billable.map((c) => toPaise(c.futureRate!)))), system: inr(toPaise(s.rates)), ok: written && toPaise(s.rates) === sum(billable.map((c) => toPaise(c.futureRate!))) },
      option === 'FULL_HISTORY'
        ? { key: 'collections', check: `Collections ${historyMonths.length ? `${MONTHS[historyMonths[0]! - 1]}–${MONTHS[historyMonths[historyMonths.length - 1]! - 1]} ${year}` : ''} (imported as payments)`, excel: inr(excelCollections), system: inr(toPaise(s.paid)), ok: written && toPaise(s.paid) === excelCollections }
        : { key: 'collections', check: 'Collections (kept as Excel history, not as payments)', excel: inr(excelCollections), system: inr(toPaise(s.legacy)), ok: written && toPaise(s.legacy) === excelCollections && toPaise(s.paid) === 0n },
      { key: 'outstanding', check: 'Outstanding at cutover', excel: inr(sum(excelClosing.map((x) => x.bal).filter((x) => x > 0n))), system: inr(sysOutstanding), ok: written && sysOutstanding === sum(excelClosing.map((x) => x.bal).filter((x) => x > 0n)) },
      { key: 'advance', check: 'Advance at cutover', excel: inr(sum(excelClosing.map((x) => x.bal).filter((x) => x < 0n).map((x) => -x))), system: inr(sysAdvance), ok: written && sysAdvance === sum(excelClosing.map((x) => x.bal).filter((x) => x < 0n).map((x) => -x)) },
    ];
    const mismatches = excelClosing
      .filter((x) => sysBal.get(x.code) !== x.bal)
      .map((x) => ({ customerCode: x.code, excel: inr(x.bal), system: sysBal.has(x.code) ? inr(sysBal.get(x.code)!) : '—' }));
    const perCustomer = { equal: written ? eff.length - mismatches.length : 0, total: eff.length, mismatches: mismatches.slice(0, 50) };
    lines.push({ key: 'perCustomer', check: 'Per-customer balance at cutover', excel: `${eff.length}`, system: `${perCustomer.equal} equal`, ok: written && mismatches.length === 0 });

    return {
      option,
      cutoverDate: cutover,
      historyYear: year,
      monthsImported: historyMonths.map((m) => ym(year, m)),
      lines,
      perCustomer,
      created,
      blockingIssues: blocking,
      ok: written && lines.every((l) => l.ok),
    };
  }
}

