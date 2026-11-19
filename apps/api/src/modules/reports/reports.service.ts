import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { addDays, businessDateOf, isBusinessDate } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { badRequest, notFound, unprocessable } from '../../common/errors';
import { SettingsService } from '../core/settings.service';
import { toPdf, toXlsx, totalsOf } from './exporters';
import { REPORT_INDEX, REPORTS, ReportDefinition, ReportFilters } from './report-definitions';

export interface ReportQuery {
  from?: string;
  to?: string;
  q?: string;
  agentId?: string;
  societyId?: string;
  areaId?: string;
  customerId?: string;
  status?: string;
  sort?: string;
  page: number;
  pageSize: number;
}

const snake = (key: string) => key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
const EXPORT_LIMIT = 50_000;
const PDF_LIMIT = 3_000;

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly settings: SettingsService,
  ) {}

  catalogue() {
    return REPORTS.map(({ key, title, description, columns, filters, statusOptions, defaultRange, defaultSort, requiresCustomer, pdf }) => ({
      key,
      title,
      description,
      columns,
      filters,
      statusOptions: statusOptions ?? null,
      defaultRange,
      defaultSort,
      requiresCustomer: !!requiresCustomer,
      formats: pdf ? ['json', 'xlsx', 'pdf'] : ['json', 'xlsx'],
    }));
  }

  private definition(key: string): ReportDefinition {
    const def = REPORT_INDEX.get(key);
    if (!def) throw notFound('REPORT_NOT_FOUND', `Unknown report "${key}"`);
    return def;
  }

  private filters(def: ReportDefinition, q: ReportQuery): ReportFilters {
    const today = businessDateOf(new Date());
    let from = q.from;
    let to = q.to;
    if (!from || !to) {
      switch (def.defaultRange) {
        case 'today':
          from ??= today;
          to ??= today;
          break;
        case 'next30':
          from ??= today;
          to ??= addDays(today, 30);
          break;
        case 'month':
          from ??= `${today.slice(0, 8)}01`;
          to ??= today;
          break;
        default:
          from ??= def.key === 'monthly-collection' ? `${addDays(`${today.slice(0, 8)}01`, -330).slice(0, 8)}01` : '1900-01-01';
          to ??= def.key === 'customer-ledger' || def.key === 'monthly-collection' ? today : '9999-12-31';
      }
    }
    if (!isBusinessDate(from) || !isBusinessDate(to)) throw badRequest('INVALID_DATE', 'Dates must be YYYY-MM-DD');
    if (to < from) throw badRequest('INVALID_RANGE', 'The end date is before the start date');
    if (def.requiresCustomer && !q.customerId) throw unprocessable('CUSTOMER_REQUIRED', 'Choose a customer for this report');
    if (q.status && def.statusOptions && !def.statusOptions.includes(q.status)) throw badRequest('INVALID_STATUS', 'Unknown status for this report');
    return {
      from,
      to,
      today,
      q: q.q,
      agentId: q.agentId,
      societyId: q.societyId,
      areaId: q.areaId,
      customerId: q.customerId,
      status: def.statusOptions ? q.status : undefined,
    };
  }

  private sortClause(def: ReportDefinition, sort: string | undefined) {
    const raw = sort ?? def.defaultSort;
    const desc = raw.startsWith('-');
    const key = desc ? raw.slice(1) : raw;
    if (!def.columns.some((c) => c.key === key)) throw badRequest('INVALID_SORT', `Cannot sort by "${key}"`);
    return sql`ORDER BY ${sql.ref(`r.${snake(key)}`)} ${sql.raw(desc ? 'DESC' : 'ASC')} NULLS LAST`;
  }

  private searchClause(def: ReportDefinition, q: string | undefined) {
    const textCols = def.columns.filter((c) => c.type === 'text').map((c) => sql.ref(`r.${snake(c.key)}`));
    if (!q || textCols.length === 0) return sql``;
    const term = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    return sql`WHERE concat_ws(' ', ${sql.join(textCols)}) ILIKE ${term}`;
  }

  async run(key: string, q: ReportQuery) {
    const def = this.definition(key);
    const f = this.filters(def, q);
    const inner = def.query(f);
    const where = this.searchClause(def, f.q);
    const order = this.sortClause(def, q.sort);
    const totalCols = def.columns.filter((c) => c.total);

    const [rows, count, totals] = await Promise.all([
      sql<Record<string, unknown>>`SELECT * FROM (${inner}) r ${where} ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`.execute(this.db),
      sql<{ n: string }>`SELECT count(*) AS n FROM (${inner}) r ${where}`.execute(this.db),
      totalCols.length
        ? sql<Record<string, string>>`SELECT ${sql.join(totalCols.map((c) => sql`coalesce(sum(${sql.ref(`r.${snake(c.key)}`)}), 0) AS ${sql.ref(snake(c.key))}`))} FROM (${inner}) r ${where}`.execute(this.db)
        : Promise.resolve({ rows: [{}] }),
    ]);
    return {
      report: { key: def.key, title: def.title, columns: def.columns },
      filters: { ...f, today: undefined },
      rows: rows.rows,
      totals: this.normaliseTotals(def, totals.rows[0] ?? {}),
      meta: { page: q.page, pageSize: q.pageSize, total: Number(count.rows[0]?.n ?? 0) },
    };
  }

  /** Full result for Excel/PDF export (bounded). */
  async export(key: string, q: ReportQuery, format: 'xlsx' | 'pdf'): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const def = this.definition(key);
    if (format === 'pdf' && !def.pdf) throw badRequest('PDF_NOT_AVAILABLE', 'This report is available in Excel only');
    const f = this.filters(def, q);
    const limit = format === 'pdf' ? PDF_LIMIT : EXPORT_LIMIT;
    const res = await sql<Record<string, unknown>>`SELECT * FROM (${def.query(f)}) r ${this.searchClause(def, f.q)} ${this.sortClause(def, q.sort)} LIMIT ${limit + 1}`.execute(this.db);
    if (res.rows.length > limit) {
      throw unprocessable('EXPORT_TOO_LARGE', `More than ${limit} rows; narrow the filters${format === 'pdf' ? ' or export to Excel' : ''}`);
    }
    const business = (await this.settings.get('business.profile')).name;
    const description = this.describeFilters(def, f);
    const stamp = businessDateOf(new Date());
    const body =
      format === 'xlsx'
        ? await toXlsx(def.title, description, def.columns, res.rows)
        : await toPdf(def.title, description, business, def.columns, res.rows);
    return {
      filename: `${def.key}_${stamp}.${format}`,
      contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
      body,
    };
  }

  private normaliseTotals(def: ReportDefinition, raw: Record<string, unknown>) {
    const asRows = [Object.fromEntries(def.columns.filter((c) => c.total).map((c) => [c.key, raw[c.key] ?? '0']))];
    return totalsOf(def.columns, asRows);
  }

  private describeFilters(def: ReportDefinition, f: ReportFilters): string {
    const parts: string[] = [];
    if (def.filters.includes('dateRange') || def.defaultRange !== 'none') {
      if (f.from !== '1900-01-01' || f.to !== '9999-12-31') parts.push(`Period: ${f.from} to ${f.to}`);
    }
    if (f.status) parts.push(`Status: ${f.status}`);
    if (f.q) parts.push(`Search: "${f.q}"`);
    if (f.agentId || f.societyId || f.areaId || f.customerId) parts.push('Filtered');
    return parts.length ? parts.join(' · ') : 'All records';
  }
}

