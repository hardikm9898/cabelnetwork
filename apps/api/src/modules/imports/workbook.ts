import ExcelJS from 'exceljs';
import type { ImportIssue } from '@cablenet/contracts';
import { fromPaise, Paise, toPaise } from '@cablenet/domain';

/**
 * Reads the cable TV Excel workbook (EXCEL_MIGRATION_MAPPING §1–4) into plain data.
 *
 * - Sheets and columns are found by their header text, not by position.
 * - Month rows are matched to customers by the Customer ID shown in the row (the workbook links
 *   them by row position, defect X-2; the ID is what the row actually displays).
 * - Formula cells are read for their saved results only to cross-check: Excel saves zero results
 *   as empty, so every money figure is recomputed here with the workbook's own formulas (§2.1),
 *   in exact paise.
 */

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'] as const;

export interface ParsedCustomer {
  row: number;
  code: string;
  name: string;
  addressLine: string;
  mobileRaw: string | null;
  mobile: string | null;
  mobileValid: boolean;
  /** As typed: "400", "AMP", "" */
  rateRaw: string;
  /** Numeric rate (decimal string) or null when the cell is text/blank (D-1/D-2). */
  rate: string | null;
  stb: string | null;
  mq: string | null;
  notes: string | null;
  society: string;
}

export interface MonthEntry {
  row: number;
  /** Payment Received (column E); null when empty. */
  received: string | null;
  paymentDate: string | null;
  notes: string | null;
  /** Saved formula results (undefined when Excel left them empty, i.e. zero). */
  cached: { opening: string | null; feeAdjusted: string | null; closingAdvance: string | null; amountDue: string | null };
}

export interface ParsedWorkbook {
  historyYear: number;
  sheets: string[];
  monthsFound: number[];
  headingRows: number;
  trimmedCells: number;
  customers: ParsedCustomer[];
  /** month (1–12) → customer code → entry */
  months: Record<number, Record<string, MonthEntry>>;
  issues: ImportIssue[];
}

/** One month of the recomputed Excel statement (same meaning as the month sheet columns). */
export interface StatementLine {
  month: number;
  rate: string;
  opening: string;
  received: string;
  feeAdjusted: string;
  closingAdvance: string;
  amountDue: string;
  paymentDate: string | null;
  notes: string | null;
}

type Cell = ExcelJS.CellValue;

function valueOf(v: Cell): unknown {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('formula' in v || 'sharedFormula' in v) return (v as { result?: unknown }).result;
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('hyperlink' in v) return (v as ExcelJS.CellHyperlinkValue).text;
    if ('error' in v) return null;
  }
  return v;
}

const isoDate = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

function asText(v: unknown): { text: string; trimmed: boolean } {
  if (v === null || v === undefined) return { text: '', trimmed: false };
  if (v instanceof Date) return { text: isoDate(v), trimmed: false };
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(v)) : String(v);
  const t = s.replace(/\s+/g, ' ').trim();
  return { text: t, trimmed: t !== s };
}

/** Number cell → decimal string with 2 places; null when empty; 'invalid' when not a number. */
function asMoney(v: unknown): string | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 'invalid';
  if (Math.round(n * 100) !== Math.round(n * 1000) / 10) return 'invalid'; // more than 2 decimals
  return fromPaise(BigInt(Math.round(n * 100)));
}

function asDate(v: unknown): string | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'invalid' : isoDate(v);
  if (typeof v === 'number') {
    // Excel serial date (days since 1899-12-30).
    const d = new Date(Math.round((v - 25569) * 86400000));
    return Number.isNaN(d.getTime()) ? 'invalid' : isoDate(d);
  }
  const s = String(v).trim();
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s) ?? null;
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return 'invalid';
}

export function normaliseMobile(raw: string): { mobile: string | null; valid: boolean } {
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!d) return { mobile: null, valid: false };
  return { mobile: d.slice(0, 15), valid: /^[6-9]\d{9}$/.test(d) };
}

/** Finds the header row (within the first rows) and maps column keys by header text. */
function headerMap(ws: ExcelJS.Worksheet, patterns: Record<string, RegExp>, maxRow = 6): { row: number; cols: Record<string, number> } | null {
  for (let r = 1; r <= Math.min(maxRow, ws.rowCount); r++) {
    const cols: Record<string, number> = {};
    ws.getRow(r).eachCell({ includeEmpty: false }, (c, n) => {
      const h = asText(valueOf(c.value)).text;
      if (!h || /^helper/i.test(h)) return;
      for (const [k, re] of Object.entries(patterns)) if (cols[k] === undefined && re.test(h)) cols[k] = n;
    });
    if (cols.id !== undefined && Object.keys(cols).length >= 3) return { row: r, cols };
  }
  return null;
}

const issue = (code: string, severity: 'error' | 'warning', message: string, at: Partial<Pick<ImportIssue, 'customerCode' | 'sheet' | 'row'>> = {}): ImportIssue => ({
  code,
  severity,
  customerCode: at.customerCode ?? null,
  sheet: at.sheet ?? null,
  row: at.row ?? null,
  message,
});

/**
 * Total uncompressed size declared in the zip's central directory (an .xlsx is a zip), read before
 * anything is inflated, so a "zip bomb" is refused instead of exhausting memory (review L-10).
 * null when the directory cannot be read (or uses ZIP64, which a workbook this size never needs).
 */
export function zipUncompressedSize(buf: Buffer): number | null {
  try {
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) !== 0x06054b50) continue;
      const entries = buf.readUInt16LE(i + 10);
      let p = buf.readUInt32LE(i + 16);
      let total = 0;
      for (let e = 0; e < entries; e++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) return null;
        const size = buf.readUInt32LE(p + 24);
        if (size === 0xffffffff) return null;
        total += size;
        p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
      }
      return total;
    }
  } catch {
    return null;
  }
  return null;
}

export const MAX_UNCOMPRESSED = 300 * 1024 * 1024;

export async function parseWorkbook(buffer: Buffer): Promise<ParsedWorkbook> {
  const inflated = zipUncompressedSize(buffer);
  if (inflated === null) throw new Error('not a readable .xlsx file');
  if (inflated > MAX_UNCOMPRESSED) throw new Error(`it would expand to ${Math.round(inflated / 1048576)} MB (limit ${MAX_UNCOMPRESSED / 1048576} MB)`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const issues: ImportIssue[] = [];
  const sheets = wb.worksheets.map((w) => w.name);

  // --- Customer master ---------------------------------------------------------------------
  const listSheet = wb.worksheets.find((w) => /customer\s*list/i.test(w.name));
  if (!listSheet) throw new Error('No "Customer List" sheet found');
  const head = headerMap(listSheet, {
    id: /customer\s*id/i,
    name: /customer\s*name|^name$/i,
    address: /address/i,
    mobile: /mobile|phone/i,
    rate: /rate/i,
    stb: /stb/i,
    mq: /^mq/i,
    notes: /^notes?$/i,
    society: /society/i,
  });
  if (!head || head.cols.name === undefined) throw new Error('The Customer List sheet has no "Customer ID" / "Customer Name" header');

  const customers: ParsedCustomer[] = [];
  let headingRows = 0;
  let trimmedCells = 0;
  const get = (row: ExcelJS.Row, key: string) => (head.cols[key] === undefined ? null : valueOf(row.getCell(head.cols[key]!).value));
  for (let r = head.row + 1; r <= listSheet.rowCount; r++) {
    const row = listSheet.getRow(r);
    const fields = ['id', 'name', 'address', 'mobile', 'rate', 'stb', 'mq', 'notes', 'society'].map((k) => asText(get(row, k)));
    trimmedCells += fields.filter((f) => f.trimmed).length;
    const [id, name, address, mobile, , stb, mq, notes, society] = fields.map((f) => f.text) as string[];
    if (!id) {
      if (fields.some((f) => f.text)) headingRows++; // society heading rows (D-7)
      continue;
    }
    const rateCell = get(row, 'rate');
    const rateMoney = asMoney(rateCell);
    const rateRaw = asText(rateCell).text;
    const m = mobile ? normaliseMobile(mobile) : { mobile: null, valid: false };
    customers.push({
      row: r,
      code: id!,
      name: name!,
      addressLine: address!,
      mobileRaw: mobile || null,
      mobile: m.mobile,
      mobileValid: m.valid,
      rateRaw,
      rate: rateMoney === 'invalid' || rateMoney === null ? null : rateMoney,
      stb: stb || null,
      mq: mq || null,
      notes: notes || null,
      society: society || '(No Society)',
    });
    if (!society) issues.push(issue('V-SOCIETY', 'warning', 'No society: grouped under "(No Society)"', { customerCode: id!, sheet: listSheet.name, row: r }));
  }

  // --- Month sheets --------------------------------------------------------------------------
  const months: Record<number, Record<string, MonthEntry>> = {};
  const monthsFound: number[] = [];
  const years = new Map<number, number>();
  for (const ws of wb.worksheets) {
    const idx = MONTHS.indexOf(ws.name.trim().toLowerCase() as (typeof MONTHS)[number]);
    if (idx < 0) continue;
    const month = idx + 1;
    const h = headerMap(ws, {
      id: /customer\s*id/i,
      rate: /monthly\s*rate/i,
      opening: /opening/i,
      received: /payment\s*received/i,
      fee: /fee\s*adjusted/i,
      closingAdvance: /closing\s*advance/i,
      due: /amount\s*due/i,
      date: /payment\s*date/i,
      notes: /^notes?$/i,
    });
    if (!h || h.cols.received === undefined) {
      issues.push(issue('V-SHEET', 'warning', `Sheet "${ws.name}" has no "Payment Received" column; skipped`, { sheet: ws.name }));
      continue;
    }
    monthsFound.push(month);
    const entries: Record<string, MonthEntry> = {};
    const cell = (row: ExcelJS.Row, key: string) => (h.cols[key] === undefined ? null : valueOf(row.getCell(h.cols[key]!).value));
    for (let r = h.row + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const code = asText(cell(row, 'id')).text;
      const receivedCell = cell(row, 'received');
      const dateCell = cell(row, 'date');
      if (!code || /total/i.test(code)) {
        if (asMoney(receivedCell) && !/total/i.test(code)) {
          issues.push(issue('V-ORPHAN', 'error', 'A payment is typed in a row that shows no Customer ID', { sheet: ws.name, row: r }));
        }
        continue;
      }
      const received = asMoney(receivedCell);
      const date = asDate(dateCell);
      if (received === 'invalid') issues.push(issue('V-AMOUNT', 'error', `Payment Received "${asText(receivedCell).text}" is not a number`, { customerCode: code, sheet: ws.name, row: r }));
      else if (received && toPaise(received) < 0n) issues.push(issue('V-AMOUNT', 'error', 'Negative payment', { customerCode: code, sheet: ws.name, row: r }));
      if (date === 'invalid') issues.push(issue('V-DATE', 'warning', `Payment Date "${asText(dateCell).text}" is not a date; ignored`, { customerCode: code, sheet: ws.name, row: r }));
      const okDate = date === 'invalid' ? null : date;
      if (okDate) years.set(Number(okDate.slice(0, 4)), (years.get(Number(okDate.slice(0, 4))) ?? 0) + 1);
      const money = (k: string) => {
        const v = asMoney(cell(row, k));
        return v === 'invalid' ? null : v;
      };
      if (entries[code]) {
        issues.push(issue('V-DUPROW', 'error', `Customer appears twice in ${ws.name}`, { customerCode: code, sheet: ws.name, row: r }));
        continue;
      }
      entries[code] = {
        row: r,
        received: received === 'invalid' ? null : received,
        paymentDate: okDate,
        notes: asText(cell(row, 'notes')).text || null,
        cached: { opening: money('opening'), feeAdjusted: money('fee'), closingAdvance: money('closingAdvance'), amountDue: money('due') },
      };
    }
    months[month] = entries;
  }
  monthsFound.sort((a, b) => a - b);
  const historyYear = [...years.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? new Date().getUTCFullYear();

  const stale = sheets.find((s) => /data\s*quality/i.test(s));
  if (stale) issues.push(issue('D-11', 'warning', `Sheet "${stale}" describes another workbook and is ignored`, { sheet: stale }));
  if (headingRows) issues.push(issue('D-7', 'warning', `${headingRows} society heading rows in the Customer List are not customers; skipped`, { sheet: listSheet.name }));
  if (trimmedCells) issues.push(issue('D-6', 'warning', `${trimmedCells} cells had extra spaces; trimmed (the workbook keeps the original)`, { sheet: listSheet.name }));
  const missing = MONTHS.map((_, i) => i + 1).filter((m) => !monthsFound.includes(m));
  if (missing.length) issues.push(issue('V-MONTHS', 'warning', `Month sheets not found: ${missing.map((m) => MONTHS[m - 1]).join(', ')}`));

  return { historyYear, sheets, monthsFound, headingRows, trimmedCells, customers, months, issues };
}

/**
 * The Excel statement of one customer, recomputed with the month-sheet formulas (§2.1):
 * D = previous G − H (January: 0), F = MIN(E + MAX(D,0), C + MAX(−D,0)),
 * G = MAX(D + E − C, 0), H = MAX(C − D − E, 0). C is the *current* rate as Excel uses it (text = 0).
 */
export function recompute(rate: string | null, months: Record<number, Record<string, MonthEntry>>, code: string, upTo = 12): StatementLine[] {
  const c = rate ? toPaise(rate) : 0n;
  const max = (a: Paise, b: Paise) => (a > b ? a : b);
  const min = (a: Paise, b: Paise) => (a < b ? a : b);
  const out: StatementLine[] = [];
  let d: Paise = 0n; // opening: + advance / − due
  for (let m = 1; m <= upTo; m++) {
    const e = months[m]?.[code];
    const paid = e?.received ? toPaise(e.received) : 0n;
    const fee = min(paid + max(d, 0n), c + max(-d, 0n));
    const adv = max(d + paid - c, 0n);
    const due = max(c - d - paid, 0n);
    out.push({
      month: m,
      rate: fromPaise(c),
      opening: fromPaise(d),
      received: fromPaise(paid),
      feeAdjusted: fromPaise(fee),
      closingAdvance: fromPaise(adv),
      amountDue: fromPaise(due),
      paymentDate: e?.paymentDate ?? null,
      notes: e?.notes ?? null,
    });
    d = adv - due;
  }
  return out;
}

/** Saved Excel results that disagree with the recomputation (zero results are saved empty). */
export function crossCheck(lines: StatementLine[], months: Record<number, Record<string, MonthEntry>>, code: string): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const e = months[l.month]?.[code];
    if (!e) continue;
    const pairs: [string, string | null, string][] = [
      ['Opening Balance', e.cached.opening, l.opening],
      ['Fee Adjusted', e.cached.feeAdjusted, l.feeAdjusted],
      ['Closing Advance', e.cached.closingAdvance, l.closingAdvance],
      ['Amount Due', e.cached.amountDue, l.amountDue],
    ];
    for (const [label, saved, computed] of pairs) {
      if (toPaise(saved ?? '0') !== toPaise(computed)) out.push(`${MONTHS[l.month - 1]} ${label}: workbook ${saved ?? '0'}, formula gives ${computed}`);
    }
  }
  return out;
}
