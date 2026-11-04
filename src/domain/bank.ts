import type { RawBankBalance } from '../uol/client.js';
import { amount, money, refId, str } from '../uol/normalize.js';

/**
 * `/v1/bank_balances` holds **monthly opening-balance snapshots** — one row
 * per account per month start — not live balances. The newest snapshot of
 * each account is its last known position; accounts are summed per currency
 * only, and every figure carries the date it is valid for.
 */

export interface AccountBalance {
  bank_account_id: string;
  currency: string;
  balance: number;
  as_of: string;
}

export interface CurrencyBalance {
  currency: string;
  total: number;
  accounts: number;
  /** Newest snapshot date that went into the total; older accounts may lag behind it. */
  as_of: string;
  oldest_snapshot: string;
}

export function latestBalances(rows: RawBankBalance[]): AccountBalance[] {
  const newest = new Map<string, RawBankBalance>();
  for (const row of rows) {
    const id = str(row.bank_account_id);
    const date = str(row.date);
    if (!id || !date) continue;
    const seen = newest.get(id);
    if (!seen || (seen.date ?? '') < date) newest.set(id, row);
  }
  return [...newest.entries()]
    .map(([id, row]) => ({
      bank_account_id: id,
      currency: refId(row.currency, 'currency_id') ?? 'CZK',
      balance: amount(row.opening_balance) ?? 0,
      as_of: (row.date ?? '').slice(0, 10),
    }))
    .sort((a, b) => a.bank_account_id.localeCompare(b.bank_account_id));
}

export function balancesByCurrency(accounts: AccountBalance[]): CurrencyBalance[] {
  const groups = new Map<string, AccountBalance[]>();
  for (const a of accounts) groups.set(a.currency, [...(groups.get(a.currency) ?? []), a]);
  return [...groups.entries()]
    .map(([currency, list]) => {
      const dates = list.map((a) => a.as_of).sort();
      return {
        currency,
        total: money(list.reduce((sum, a) => sum + a.balance, 0)),
        accounts: list.length,
        as_of: dates[dates.length - 1]!,
        oldest_snapshot: dates[0]!,
      };
    })
    .sort((a, b) => b.accounts - a.accounts || a.currency.localeCompare(b.currency));
}
