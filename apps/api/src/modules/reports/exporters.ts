import { Workbook } from 'exceljs';
import PdfPrinter from 'pdfmake';
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces';
import { formatDateIN, formatInr, fromPaise, toPaise } from '@cablenet/domain';

// Roboto ships with pdfmake and includes the ₹ glyph.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vfs = require('pdfmake/build/vfs_fonts.js') as Record<string, string>;
const font = (name: string) => Buffer.from(vfs[name]!, 'base64');
const printer = new PdfPrinter({
  Roboto: {
    normal: font('Roboto-Regular.ttf'),
    bold: font('Roboto-Medium.ttf'),
    italics: font('Roboto-Italic.ttf'),
    bolditalics: font('Roboto-MediumItalic.ttf'),
  },
});

export type ColumnType = 'text' | 'money' | 'number' | 'date' | 'datetime' | 'boolean';

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
  /** Include in the totals row. */
  total?: boolean;
}

export const indianDate = formatDateIN;
export { formatInr };

const display = (v: unknown, type: ColumnType): string => {
  if (v === null || v === undefined) return '';
  if (type === 'money') return formatInr(String(v));
  if (type === 'date') return indianDate(String(v));
  if (type === 'datetime') return new Date(v as string).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  if (type === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};

export function totalsOf(columns: ReportColumn[], rows: Record<string, unknown>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of columns.filter((c) => c.total)) {
    const sum = rows.reduce((s, r) => s + (r[c.key] == null ? 0n : c.type === 'money' ? toPaise(String(r[c.key])) : BigInt(String(r[c.key])) * 100n), 0n);
    out[c.key] = c.type === 'money' ? fromPaise(sum) : String(sum / 100n);
  }
  return out;
}

export async function toXlsx(title: string, filters: string, columns: ReportColumn[], rows: Record<string, unknown>[]): Promise<Buffer> {
  const wb = new Workbook();
  wb.creator = 'Cable Network';
  wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([filters]).font = { italic: true, color: { argb: 'FF666666' } };
  ws.addRow([]);
  const header = ws.addRow(columns.map((c) => c.label));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF6' } };
  });
  for (const r of rows) {
    ws.addRow(
      columns.map((c) => {
        const v = r[c.key];
        if (v === null || v === undefined) return null;
        // Excel stores numbers as doubles; amounts are exact to 2 decimals for display/analysis.
        if (c.type === 'money' || c.type === 'number') return Number(v);
        if (c.type === 'date') return String(v);
        if (c.type === 'datetime') return new Date(v as string);
        if (c.type === 'boolean') return v ? 'Yes' : 'No';
        return String(v);
      }),
    );
  }
  const totals = totalsOf(columns, rows);
  if (Object.keys(totals).length) {
    const t = ws.addRow(columns.map((c, i) => (i === 0 ? 'TOTAL' : totals[c.key] !== undefined ? Number(totals[c.key]) : null)));
    t.font = { bold: true };
  }
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(40, Math.max(12, c.label.length + 4));
    if (c.type === 'money') col.numFmt = '#,##0.00';
    if (c.type === 'datetime') col.numFmt = 'dd-mm-yyyy hh:mm';
  });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function render(doc: TDocumentDefinitions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = printer.createPdfKitDocument(doc);
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

export function toPdf(title: string, filters: string, business: string, columns: ReportColumn[], rows: Record<string, unknown>[]): Promise<Buffer> {
  const totals = totalsOf(columns, rows);
  const right = (c: ReportColumn) => c.type === 'money' || c.type === 'number';
  const body: TableCell[][] = [
    columns.map((c) => ({ text: c.label, bold: true, fillColor: '#E8EEF6', alignment: right(c) ? 'right' : 'left' })),
    ...rows.map((r) => columns.map((c) => ({ text: display(r[c.key], c.type), alignment: right(c) ? 'right' : 'left' }) as TableCell)),
  ];
  if (Object.keys(totals).length) {
    body.push(
      columns.map((c, i) => ({
        text: i === 0 ? 'TOTAL' : totals[c.key] !== undefined ? display(totals[c.key], c.type) : '',
        bold: true,
        alignment: right(c) ? 'right' : 'left',
      })),
    );
  }
  return render({
    pageSize: 'A4',
    pageOrientation: columns.length > 6 ? 'landscape' : 'portrait',
    pageMargins: [28, 40, 28, 36],
    defaultStyle: { font: 'Roboto', fontSize: 8 },
    header: { text: business, margin: [28, 16, 28, 0], fontSize: 8, color: '#666666' },
    footer: (page, count) => ({
      columns: [
        { text: `Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`, color: '#666666' },
        { text: `Page ${page} of ${count}`, alignment: 'right', color: '#666666' },
      ],
      margin: [28, 8, 28, 0],
      fontSize: 7,
    }),
    content: [
      { text: title, fontSize: 14, bold: true },
      { text: filters, color: '#666666', margin: [0, 2, 0, 10] },
      { table: { headerRows: 1, body, widths: columns.map((c) => (c.type === 'text' ? '*' : 'auto')) }, layout: 'lightHorizontalLines' },
    ],
  });
}

export interface ReceiptPdfInput {
  business: { name: string; address?: string | null; phone?: string | null; gstin?: string | null; footer?: string | null };
  receiptNumber: string;
  status: string;
  issuedAt: string;
  payment: { amount: string; paymentDate: string; mode: string; reference: string | null; collectedBy: string | null };
  customer: { code: string; name: string; mobile: string | null; address: string };
  allocations: { label: string; amount: string }[];
  advanceCreated: string;
  previousOutstanding: string;
  remainingOutstanding: string;
  remainingAdvance: string;
  reissueOf: string | null;
}

/** A6 receipt, readable on a phone and printable. */
/** 98xxxxxx12 */
const maskMobile = (m: string) => (m.length >= 6 ? `${m.slice(0, 2)}${'x'.repeat(m.length - 4)}${m.slice(-2)}` : 'xxxx');

/**
 * `publicView`: the copy behind a shareable link, which may be forwarded. It leaves out the address,
 * the full mobile number, the collector and earlier balances (security review M-3).
 */
export function receiptPdf(r: ReceiptPdfInput, opts: { publicView?: boolean } = {}): Promise<Buffer> {
  const pub = !!opts.publicView;
  const line = (label: string, value: string, bold = false): Content => ({
    columns: [{ text: label, color: '#555555' }, { text: value, alignment: 'right', bold }],
    margin: [0, 1, 0, 1],
  });
  const rows: Content[] = [
    { text: r.business.name, bold: true, fontSize: 13, alignment: 'center' },
    ...(r.business.address ? [{ text: r.business.address, alignment: 'center' as const, color: '#555555' }] : []),
    ...(r.business.phone ? [{ text: `Phone: ${r.business.phone}`, alignment: 'center' as const, color: '#555555' }] : []),
    ...(r.business.gstin ? [{ text: `GSTIN: ${r.business.gstin}`, alignment: 'center' as const, color: '#555555' }] : []),
    { text: 'PAYMENT RECEIPT', bold: true, alignment: 'center', margin: [0, 8, 0, 4] },
    ...(r.status === 'CANCELLED' ? [{ text: 'CANCELLED', color: '#B00020', bold: true, alignment: 'center' as const, fontSize: 12 }] : []),
    line('Receipt no.', r.receiptNumber, true),
    line('Date', indianDate(r.payment.paymentDate)),
    line('Issued', new Date(r.issuedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })),
    ...(r.reissueOf ? [line('Replaces', r.reissueOf)] : []),
    { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 250, y2: 4, lineWidth: 0.5, lineColor: '#cccccc' }] },
    line('Customer ID', r.customer.code),
    line('Name', r.customer.name),
    ...(r.customer.mobile ? [line('Mobile', pub ? maskMobile(r.customer.mobile) : r.customer.mobile)] : []),
    ...(pub ? [] : [{ text: r.customer.address, color: '#555555', margin: [0, 1, 0, 4] as [number, number, number, number] }]),
    { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 250, y2: 4, lineWidth: 0.5, lineColor: '#cccccc' }] },
    line('Amount received', formatInr(r.payment.amount), true),
    line('Mode', r.payment.mode.replace('_', ' ')),
    ...(r.payment.reference ? [line('Reference', r.payment.reference)] : []),
    ...(r.payment.collectedBy && !pub ? [line('Collected by', r.payment.collectedBy)] : []),
    { text: 'Applied to', bold: true, margin: [0, 6, 0, 2] },
    ...r.allocations.map((a) => line(a.label, formatInr(a.amount))),
    ...(toPaise(r.advanceCreated) > 0n ? [line('Kept as advance', formatInr(r.advanceCreated))] : []),
    { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 250, y2: 4, lineWidth: 0.5, lineColor: '#cccccc' }] },
    ...(pub ? [] : [line('Previous outstanding', formatInr(r.previousOutstanding))]),
    line('Remaining outstanding', formatInr(r.remainingOutstanding), true),
    ...(pub ? [] : [line('Advance balance', formatInr(r.remainingAdvance))]),
    ...(r.business.footer ? [{ text: r.business.footer, alignment: 'center' as const, color: '#555555', margin: [0, 10, 0, 0] as [number, number, number, number] }] : []),
    { text: 'Computer-generated receipt.', alignment: 'center', color: '#999999', fontSize: 7, margin: [0, 8, 0, 0] },
  ];
  return render({ pageSize: 'A6', pageMargins: [20, 20, 20, 20], defaultStyle: { font: 'Roboto', fontSize: 8.5 }, content: rows });
}
