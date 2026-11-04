import type { RawAccountingRecord, UolClient } from '../uol/client.js';
import { amount, money, refId } from '../uol/normalize.js';
import { fetchPages } from './paging.js';

/**
 * Revenue and expenses the way UOL's own dashboard reports them: from the
 * general ledger, not from invoices, so rent, payroll, travel and FX postings
 * booked through internal documents count too. Czech chart of accounts:
 * class 6 = výnosy (revenue), class 5 = náklady (expenses); ledger amounts are
 * net of VAT (VAT sits on 343).
 *
 * Each class is read from both sides — a credit note or reversal debits a 6xx
 * account — and postings against class 7 (year-end closing accounts such as
 * 710) are left out, otherwise the closing entries would wipe out December.
 */

/** Pages per query (250 rows each); four queries per call. */
export const MAX_LEDGER_PAGES = 40;

export interface MonthFigures {
  month: string;
  revenue: number;
  expenses: number;
  profit: number;
}

export interface AccountTotal {
  /** Synthetic (3-digit) account of the Czech chart of accounts, e.g. 602, 518. */
  account: string;
  amount: number;
}

export interface LedgerSummary {
  months: MonthFigures[];
  revenue_by_account: AccountTotal[];
  expenses_by_account: AccountTotal[];
  truncated: boolean;
}

type Side = 'debit' | 'credit';

const QUERIES: { side: Side; cls: '5' | '6' }[] = [
  { side: 'credit', cls: '6' },
  { side: 'debit', cls: '6' },
  { side: 'debit', cls: '5' },
  { side: 'credit', cls: '5' },
];

/** `YYYY-MM` keys of the [count] months ending with [today]'s month, oldest first. */
export function monthKeys(today: string, count: number): string[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return Array.from({ length: count }, (_, i) => {
    const total = year * 12 + (month - 1) - (count - 1 - i);
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
  });
}

export async function ledgerSummary(client: UolClient, months: string[], today: string): Promise<LedgerSummary> {
  const range = { date_from: `${months[0]}-01`, date_till: today };
  const results = await Promise.all(
    QUERIES.map(({ side, cls }) =>
      fetchPages(
        (page, perPage) => client.accountingRecords({ ...range, [`${side}_account`]: cls, page, per_page: perPage }),
        MAX_LEDGER_PAGES,
      ).then((result) => ({ side, cls, ...result })),
    ),
  );

  const byMonth = new Map(months.map((m) => [m, { revenue: 0, expenses: 0 }]));
  const revenueByAccount = new Map<string, number>();
  const expensesByAccount = new Map<string, number>();

  for (const { side, cls, rows } of results) {
    for (const row of rows) {
      const posting = classify(row, side, cls);
      if (!posting) continue;
      const bucket = byMonth.get(posting.month);
      if (!bucket) continue;
      const accounts = cls === '6' ? revenueByAccount : expensesByAccount;
      accounts.set(posting.account, (accounts.get(posting.account) ?? 0) + posting.amount);
      if (cls === '6') bucket.revenue += posting.amount;
      else bucket.expenses += posting.amount;
    }
  }

  return {
    months: months.map((month) => {
      const { revenue, expenses } = byMonth.get(month)!;
      return { month, revenue: money(revenue), expenses: money(expenses), profit: money(revenue - expenses) };
    }),
    revenue_by_account: topAccounts(revenueByAccount),
    expenses_by_account: topAccounts(expensesByAccount),
    truncated: results.some((r) => r.truncated),
  };
}

/**
 * Signed contribution of one posting to class [cls], as seen from the
 * [side] the query filtered on: revenue grows on the credit side of 6xx,
 * expenses on the debit side of 5xx.
 */
function classify(row: RawAccountingRecord, side: Side, cls: '5' | '6') {
  if (row.status?.toLowerCase() !== 'valid') return undefined;
  const debit = refId(row.debit_account, 'chart_of_account_id') ?? '';
  const credit = refId(row.credit_account, 'chart_of_account_id') ?? '';
  const own = side === 'debit' ? debit : credit;
  const other = side === 'debit' ? credit : debit;
  if (!own.startsWith(cls) || other.startsWith('7')) return undefined;
  const value = amount(row.accounting_amount) ?? amount(row.amount) ?? 0;
  const growsOn: Side = cls === '6' ? 'credit' : 'debit';
  return {
    month: (row.date ?? '').slice(0, 7),
    account: own.slice(0, 3),
    amount: side === growsOn ? value : -value,
  };
}

function topAccounts(totals: Map<string, number>, limit = 10): AccountTotal[] {
  return [...totals.entries()]
    .map(([account, value]) => ({ account, amount: money(value) }))
    .filter((t) => t.amount !== 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, limit);
}
