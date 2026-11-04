import type { Query } from '../uol/http.js';
import type { RawReceivable, UolClient } from '../uol/client.js';
import { amount, daysBetween, money, receivableKind, str } from '../uol/normalize.js';
import { fetchPages } from './paging.js';

/**
 * `/v1/receivables` is the only place UOL exposes how much of an invoice has
 * been paid. It covers **sales invoices only** — `invoice_type` is `N`
 * (standard), `Z` (proforma) or `D` (corrective) — and its ids overlap with
 * purchase invoice ids, so it must never be joined against purchases.
 */

/** Upper bound on pages pulled for one answer (250 rows each). */
export const MAX_RECEIVABLE_PAGES = 8;

export function fetchAllReceivables(
  client: UolClient,
  query: Query,
): Promise<{ rows: RawReceivable[]; truncated: boolean }> {
  return fetchPages((page, perPage) => client.receivables({ ...query, page, per_page: perPage }), MAX_RECEIVABLE_PAGES);
}

export function outstanding(row: RawReceivable): number {
  return money((amount(row.total_amount) ?? 0) - (amount(row.paid_amount) ?? 0));
}

export interface ReceivableRow {
  invoice_id: string;
  number: string | null;
  kind: 'standard' | 'proforma' | 'corrective' | 'unknown';
  customer: { id: string | null; name: string | null };
  currency: string | null;
  issue_date: string | null;
  due_date: string | null;
  total: number | null;
  paid: number | null;
  outstanding: number;
  /** 0 when not yet due or nothing is outstanding. */
  days_overdue: number;
  last_payment_date: string | null;
}

export interface ReceivableTotals {
  currency: string;
  count: number;
  total: number;
  paid: number;
  outstanding: number;
  overdue_count: number;
  overdue_outstanding: number;
}

export function receivableRow(raw: RawReceivable, today: string): ReceivableRow {
  const due = outstanding(raw);
  const dueDate = str(raw.due_date);
  const late = dueDate && due > 0 ? daysBetween(dueDate, today) : 0;
  return {
    invoice_id: String(raw.invoice_id ?? ''),
    number: str(raw.invoice_public_id),
    kind: receivableKind(raw.invoice_type),
    customer: { id: str(raw.contact_id), name: null },
    currency: str(raw.currency_id),
    issue_date: str(raw.issue_date),
    due_date: dueDate,
    total: amount(raw.total_amount),
    paid: amount(raw.paid_amount),
    outstanding: due,
    days_overdue: Math.max(0, late),
    last_payment_date: str(raw.last_payment_date),
  };
}

/** Per-currency totals, largest outstanding first. Currencies are never added together. */
export function receivableTotals(rows: ReceivableRow[]): ReceivableTotals[] {
  const byCurrency = new Map<string, ReceivableTotals>();
  for (const r of rows) {
    const currency = r.currency ?? 'CZK';
    const t = byCurrency.get(currency) ?? {
      currency,
      count: 0,
      total: 0,
      paid: 0,
      outstanding: 0,
      overdue_count: 0,
      overdue_outstanding: 0,
    };
    t.count += 1;
    t.total = money(t.total + (r.total ?? 0));
    t.paid = money(t.paid + (r.paid ?? 0));
    t.outstanding = money(t.outstanding + r.outstanding);
    if (r.days_overdue > 0) {
      t.overdue_count += 1;
      t.overdue_outstanding = money(t.overdue_outstanding + r.outstanding);
    }
    byCurrency.set(currency, t);
  }
  return [...byCurrency.values()].sort((a, b) => b.outstanding - a.outstanding);
}

export type PaymentState = 'paid' | 'unpaid' | 'partially_paid' | 'not_applicable' | 'unknown';

export interface Payment {
  state: PaymentState;
  /** Amount still due in the invoice currency; negative for an unsettled credit note. */
  outstanding: number | null;
}

export function paymentOfReceivable(row: RawReceivable): Payment {
  const due = outstanding(row);
  const paid = amount(row.paid_amount) ?? 0;
  return { state: due === 0 ? 'paid' : paid !== 0 ? 'partially_paid' : 'unpaid', outstanding: due };
}

/**
 * Snapshot of every unpaid sales receivable, cached briefly so a page of
 * invoices can show payment status without one receivables call per row.
 */
export class UnpaidReceivables {
  private snapshot?: { at: number; byId: Map<string, RawReceivable>; truncated: boolean };

  constructor(
    private readonly client: UolClient,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Payment status for a sales invoice; [issued] is false for drafts and cancelled invoices. */
  async paymentOf(invoiceId: string, issued: boolean, total: number | null): Promise<Payment> {
    if (!issued) return { state: 'not_applicable', outstanding: null };
    const snapshot = await this.load().catch(() => undefined);
    if (!snapshot) return { state: 'unknown', outstanding: null };
    const row = snapshot.byId.get(invoiceId);
    if (row) return paymentOfReceivable(row);
    if (snapshot.truncated) return { state: 'unknown', outstanding: null };
    return { state: 'paid', outstanding: total === null ? null : 0 };
  }

  private async load() {
    if (this.snapshot && this.now() - this.snapshot.at < this.ttlMs) return this.snapshot;
    const { rows, truncated } = await fetchAllReceivables(this.client, { state: 'unpaid' });
    const byId = new Map<string, RawReceivable>();
    for (const row of rows) {
      const id = str(row.invoice_id);
      if (id && !row.cancelled) byId.set(id, row);
    }
    this.snapshot = { at: this.now(), byId, truncated };
    return this.snapshot;
  }
}
