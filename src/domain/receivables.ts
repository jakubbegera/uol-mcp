import type { Query } from '../uol/http.js';
import type { RawReceivable, UolClient } from '../uol/client.js';
import { amount, money, str } from '../uol/normalize.js';

/**
 * `/v1/receivables` is the only place UOL exposes how much of an invoice has
 * been paid. It covers **sales invoices only** — `invoice_type` is `N`
 * (standard), `Z` (proforma) or `D` (corrective) — and its ids overlap with
 * purchase invoice ids, so it must never be joined against purchases.
 */

/** Upper bound on pages pulled for one answer (250 rows each). */
export const MAX_RECEIVABLE_PAGES = 8;

export async function fetchAllReceivables(
  client: UolClient,
  query: Query,
): Promise<{ rows: RawReceivable[]; truncated: boolean }> {
  const rows: RawReceivable[] = [];
  for (let page = 1; page <= MAX_RECEIVABLE_PAGES; page++) {
    const body = await client.receivables({ ...query, per_page: 250, page });
    rows.push(...(body.items ?? []));
    if (!body._meta?.pagination?.next) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export function outstanding(row: RawReceivable): number {
  return money((amount(row.total_amount) ?? 0) - (amount(row.paid_amount) ?? 0));
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
