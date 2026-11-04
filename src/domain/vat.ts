import type { RawInternalDocument, RawPurchaseInvoice, RawSalesInvoice, UolClient } from '../uol/client.js';
import { amount, daysBetween, money, refId, str } from '../uol/normalize.js';
import { fetchPages } from './paging.js';

/**
 * VAT per filing period. Two sources, in order of preference:
 *
 *  1. The **closing document**: when a period is closed UOL books a confirmed
 *     internal document with `note = "DPH …"` whose `Výstup …%` / `Vstup …%`
 *     lines are the final output / input VAT. Exact; covers internal
 *     documents and reverse charge too.
 *  2. An **estimate from invoices** for periods not closed yet: VAT amounts of
 *     issued sales and purchase invoices by DUZP. Proformas and non-tax
 *     documents are skipped; corrective invoices are counted as credit notes —
 *     UOL reports their amounts as positive numbers.
 *
 * Returns are due on the 25th of the month after the period ends.
 */

export type VatKind = 'monthly' | 'quarterly';

export const MAX_VAT_PAGES = 20;

export interface VatWindow {
  label: string;
  start: string;
  /** First day after the period. */
  endExclusive: string;
}

export interface VatFigures {
  period: string;
  start: string;
  end: string;
  output_vat: number;
  input_vat: number;
  /** Positive = to pay, negative = excess deduction (nadměrný odpočet). */
  to_pay: number;
  due_date: string;
  days_left: number;
  source: 'closing_document' | 'invoices_estimate';
  preliminary: boolean;
  closing_document: string | null;
  invoices_counted: { sales: number; purchases: number } | null;
}

const ymd = (year: number, month: number, day = 1) => {
  const total = year * 12 + (month - 1);
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** The [count] most recent periods, newest first; offset 0 is the period containing [today]. */
export function vatWindows(today: string, kind: VatKind, count: number): VatWindow[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const step = kind === 'monthly' ? 1 : 3;
  const anchor = kind === 'monthly' ? month : Math.floor((month - 1) / 3) * 3 + 1;
  return Array.from({ length: count }, (_, offset) => {
    const startMonth = anchor - offset * step;
    const start = ymd(year, startMonth);
    const label = kind === 'monthly' ? start.slice(0, 7) : `${start.slice(0, 4)}-Q${Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1}`;
    return { label, start, endExclusive: ymd(year, startMonth + step) };
  });
}

export async function vatOverview(
  client: UolClient,
  kind: VatKind,
  count: number,
  today: string,
): Promise<{ periods: VatFigures[]; truncated: boolean }> {
  const windows = vatWindows(today, kind, count);
  const from = windows[windows.length - 1]!.start;
  const [docs, sales, purchases] = await Promise.all([
    fetchPages((page, perPage) => client.internalDocuments({ page, per_page: perPage }), MAX_VAT_PAGES),
    fetchPages(
      (page, perPage) => client.salesInvoices({ tax_payment_date_from: from, page, per_page: perPage }),
      MAX_VAT_PAGES,
    ),
    fetchPages(
      (page, perPage) => client.purchaseInvoices({ tax_payment_date_from: from, page, per_page: perPage }),
      MAX_VAT_PAGES,
    ),
  ]);

  const closing = docs.rows.filter((d) => d.status === 'confirmed' && (d.note ?? '').startsWith('DPH '));
  const periods = windows.map((w) => {
    const doc = closing.find((d) => inWindow(str(d.date), w));
    const due = ymd(Number(w.endExclusive.slice(0, 4)), Number(w.endExclusive.slice(5, 7)), 25);
    const base = {
      period: w.label,
      start: w.start,
      end: dayBefore(w.endExclusive),
      due_date: due,
      days_left: daysBetween(today, due),
    };
    if (doc) {
      const { output, input } = closingTotals(doc);
      return {
        ...base,
        output_vat: output,
        input_vat: input,
        to_pay: money(output - input),
        source: 'closing_document' as const,
        preliminary: false,
        closing_document: str(doc.number),
        invoices_counted: null,
      };
    }
    const salesIn = sales.rows.filter((i) => countsForVat(i, w));
    const purchasesIn = purchases.rows.filter((i) => countsForVat(i, w));
    const output = money(salesIn.reduce((sum, i) => sum + invoiceVat(i), 0));
    const input = money(purchasesIn.reduce((sum, i) => sum + invoiceVat(i), 0));
    return {
      ...base,
      output_vat: output,
      input_vat: input,
      to_pay: money(output - input),
      source: 'invoices_estimate' as const,
      preliminary: true,
      closing_document: null,
      invoices_counted: { sales: salesIn.length, purchases: purchasesIn.length },
    };
  });

  return { periods, truncated: docs.truncated || sales.truncated || purchases.truncated };
}

function closingTotals(doc: RawInternalDocument): { output: number; input: number } {
  let output = 0;
  let input = 0;
  for (const item of doc.items ?? []) {
    const value = amount(item.accounting_amount) ?? amount(item.amount) ?? 0;
    const text = item.description ?? '';
    if (text.startsWith('Výstup')) output += value;
    else if (text.startsWith('Vstup')) input += value;
  }
  return { output: money(output), input: money(input) };
}

function countsForVat(invoice: RawSalesInvoice | RawPurchaseInvoice, w: VatWindow): boolean {
  if (invoice.status !== 'confirmed') return false;
  if (invoice.type === 'proforma' || invoice.vat_document === false) return false;
  return inWindow(str(invoice.tax_payment_date) ?? str(invoice.issue_date), w);
}

/** VAT of one invoice in the home currency, negative for corrective invoices. */
function invoiceVat(invoice: RawSalesInvoice | RawPurchaseInvoice): number {
  const vat = [invoice.vat1_amount, invoice.vat2_amount, invoice.vat3_amount].reduce<number>(
    (sum, v) => sum + (amount(v) ?? 0),
    0,
  );
  const currency = refId(invoice.currency, 'currency_id') ?? 'CZK';
  const rate = amount(invoice.exchange_rate);
  const home = currency === 'CZK' || !rate ? vat : vat * rate;
  return invoice.type === 'corrective' ? -home : home;
}

function inWindow(date: string | null, w: VatWindow): boolean {
  if (!date) return false;
  const day = date.slice(0, 10);
  return day >= w.start && day < w.endExclusive;
}

function dayBefore(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
