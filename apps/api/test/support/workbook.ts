import ExcelJS from 'exceljs';

/** Builds a workbook laid out like the business's Excel file (EXCEL_MIGRATION_MAPPING §1–2). */
export interface WbCustomer {
  code: string;
  name: string;
  address: string;
  mobile: string | number | null;
  rate: number | string | null;
  stb: string | null;
  society: string;
}
export type WbPayments = Record<string, Record<number, { amount?: number; date?: string }>>;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export async function buildWorkbook(customers: WbCustomer[], payments: WbPayments, opts: { headingRows?: boolean } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const list = wb.addWorksheet('Customer List');
  list.addRow(['Customer ID', 'Customer Name', 'Address', 'Mobile', 'Monthly Rate', 'STB No', 'MQ No', 'Notes', 'Society (Group)', 'Helper: Society']);
  list.addRow([null, null, '  FIRST GROUP  ']); // stray heading row, as in the real file
  const rowOf = new Map<string, number>();
  let lastSociety = '';
  for (const c of customers) {
    if (opts.headingRows !== false && c.society !== lastSociety && lastSociety) list.addRow([null, null, c.society, null, null, null, null, c.society]);
    lastSociety = c.society;
    const r = list.addRow([c.code, c.name, c.address, c.mobile, c.rate, c.stb, null, null, c.society, { formula: 'TRIM(I3)', result: c.society }]);
    rowOf.set(c.code, r.number);
  }
  // Saved formula results, computed like Excel; zero results are left empty (as Excel saves them).
  const opening = new Map(customers.map((c) => [c.code, 0]));
  const z = (n: number) => (n === 0 ? undefined : n);
  for (let m = 1; m <= 12; m++) {
    const ws = wb.addWorksheet(MONTHS[m - 1]!);
    const up = MONTHS[m - 1]!.toUpperCase();
    ws.addRow([`Customer ID (${up})`, 'Customer Name', 'Monthly Rate', 'Opening Balance (+Advance/-Due)', `Payment Received (${up})`, 'Fee Adjusted', 'Closing Advance', 'Amount Due', `Payment Date (${up})`, 'Notes', 'Society']);
    for (const c of customers) {
      const p = payments[c.code]?.[m];
      const listRow = rowOf.get(c.code)!;
      const C = typeof c.rate === 'number' ? c.rate : 0;
      const D = opening.get(c.code)!;
      const E = p?.amount ?? 0;
      const F = Math.min(E + Math.max(D, 0), C + Math.max(-D, 0));
      const G = Math.max(D + E - C, 0);
      const H = Math.max(C - D - E, 0);
      opening.set(c.code, G - H);
      ws.addRow([
        { formula: `IF('Customer List'!A${listRow}="","",'Customer List'!A${listRow})`, result: c.code },
        { formula: `'Customer List'!B${listRow}`, result: c.name },
        { formula: `N('Customer List'!E${listRow})`, result: typeof c.rate === 'number' ? c.rate : undefined },
        { formula: m === 1 ? '0' : `${MONTHS[m - 2]}!G2-${MONTHS[m - 2]}!H2`, result: z(D) },
        p?.amount ?? null,
        { formula: 'MIN(E2+MAX(D2,0),C2+MAX(-D2,0))', result: z(F) },
        { formula: 'MAX(D2+E2-C2,0)', result: z(G) },
        { formula: 'MAX(C2-D2-E2,0)', result: z(H) },
        p?.date ? new Date(`${p.date}T00:00:00Z`) : null,
        null,
        { formula: `'Customer List'!I${listRow}&""`, result: c.society },
      ]);
    }
    ws.addRow([]);
    ws.addRow(['MONTH TOTAL', 'TOTAL']);
  }
  wb.addWorksheet('Data Quality Report').addRow(['Describes another workbook']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Every month from `from` to `to` paid with `amount` on the 5th. */
export function monthly(year: number, amount: number, from = 1, to = 12) {
  const out: Record<number, { amount: number; date: string }> = {};
  for (let m = from; m <= to; m++) out[m] = { amount, date: `${year}-${String(m).padStart(2, '0')}-05` };
  return out;
}
