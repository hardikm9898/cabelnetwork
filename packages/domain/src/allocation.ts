import type { Paise } from './money';

/**
 * Oldest-outstanding-first (FIFO) allocation planner (docs/FINANCIAL_LOGIC.md §3.1).
 *
 * Inputs are already ordered by the caller:
 *  - credits: oldest first (credit date, created at, id)
 *  - invoices: oldest first (opening balance first, then period/billing date, id)
 * A credit with `targetInvoiceId` (e.g. a discount on a specific bill) is applied to that
 * invoice first; any remainder joins the FIFO pool.
 *
 * The planner only *adds* allocations; it never moves existing ones.
 */
export interface OpenCredit {
  ref: string;
  remaining: Paise;
  targetInvoiceId?: string | null;
}

export interface OpenInvoice {
  id: string;
  remaining: Paise;
}

export interface PlannedAllocation {
  creditRef: string;
  invoiceId: string;
  amount: Paise;
}

export function planAllocation(credits: readonly OpenCredit[], invoices: readonly OpenInvoice[]): PlannedAllocation[] {
  for (const c of credits) if (c.remaining < 0n) throw new RangeError(`Negative credit ${c.ref}`);
  for (const i of invoices) if (i.remaining < 0n) throw new RangeError(`Negative invoice balance ${i.id}`);

  const creditLeft = new Map(credits.map((c) => [c.ref, c.remaining]));
  const invoiceLeft = new Map(invoices.map((i) => [i.id, i.remaining]));
  const plan: PlannedAllocation[] = [];

  const take = (creditRef: string, invoiceId: string) => {
    const c = creditLeft.get(creditRef)!;
    const i = invoiceLeft.get(invoiceId) ?? 0n;
    const x = c < i ? c : i;
    if (x <= 0n) return;
    creditLeft.set(creditRef, c - x);
    invoiceLeft.set(invoiceId, i - x);
    const last = plan[plan.length - 1];
    if (last && last.creditRef === creditRef && last.invoiceId === invoiceId) last.amount += x;
    else plan.push({ creditRef, invoiceId, amount: x });
  };

  // 1. Targeted credits settle their own invoice first.
  for (const c of credits) {
    if (c.targetInvoiceId && invoiceLeft.has(c.targetInvoiceId)) take(c.ref, c.targetInvoiceId);
  }
  // 2. FIFO: oldest credit pays oldest invoice.
  for (const c of credits) {
    for (const inv of invoices) {
      if (creditLeft.get(c.ref)! === 0n) break;
      take(c.ref, inv.id);
    }
  }
  return plan;
}
