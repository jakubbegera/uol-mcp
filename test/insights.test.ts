import { tmpdir } from 'node:os';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { balancesByCurrency, latestBalances } from '../src/domain/bank.js';
import { monthKeys } from '../src/domain/ledger.js';
import { vatWindows } from '../src/domain/vat.js';
import { connect, demoConfig, fakeUolFetch, synthetic } from './support/fake-uol.js';

type Json = Record<string, any>;

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function call(name: string, args: Json = {}) {
  const { fetch, requests } = fakeUolFetch();
  client = await connect(demoConfig(tmpdir()), fetch);
  const result = await client.callTool({ name, arguments: args });
  return { result, data: result.structuredContent as Json, requests };
}

describe('periods', () => {
  it('lists month keys across a year boundary, oldest first', () => {
    expect(monthKeys('2026-02-15', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('builds quarterly VAT windows, newest first', () => {
    expect(vatWindows('2026-11-04', 'quarterly', 3)).toEqual([
      { label: '2026-Q4', start: '2026-10-01', endExclusive: '2027-01-01' },
      { label: '2026-Q3', start: '2026-07-01', endExclusive: '2026-10-01' },
      { label: '2026-Q2', start: '2026-04-01', endExclusive: '2026-07-01' },
    ]);
  });

  it('builds monthly VAT windows across a year boundary', () => {
    expect(vatWindows('2026-01-10', 'monthly', 2).map((w) => w.label)).toEqual(['2026-01', '2025-12']);
  });
});

describe('bank balances', () => {
  it('keeps the newest snapshot per account and sums per currency only', () => {
    // arrange
    const rows = synthetic<{ items: Json[] }>('bank_balances').items;

    // act
    const accounts = latestBalances(rows);
    const totals = balancesByCurrency(accounts);

    // assert
    expect(accounts.map((a) => [a.bank_account_id, a.balance, a.as_of])).toEqual([
      ['cs_czk', 100000.5, '2026-11-01'],
      ['cs_eur', 1000, '2026-11-01'],
      ['fio_czk', 5000, '2026-10-01'],
    ]);
    expect(totals).toEqual([
      { currency: 'CZK', total: 105000.5, accounts: 2, as_of: '2026-11-01', oldest_snapshot: '2026-10-01' },
      { currency: 'EUR', total: 1000, accounts: 1, as_of: '2026-11-01', oldest_snapshot: '2026-11-01' },
    ]);
  });
});

describe('get_financial_overview', () => {
  it('nets both sides of classes 5 and 6, uses home-currency amounts and skips closing and unposted entries', async () => {
    // act
    const { data, requests } = await call('get_financial_overview', { months: 2 });

    // assert
    expect(data.months).toEqual([
      { month: '2026-10', revenue: 12500, expenses: 10000, profit: 2500 },
      { month: '2026-11', revenue: -3000, expenses: -500, profit: -2500 },
    ]);
    expect(data.totals).toEqual({ revenue: 9500, expenses: 9500, profit: 0 });
    expect(data.current_vs_previous).toMatchObject({ month: '2026-11', previous_month: '2026-10', revenue_change_pct: -124 });
    expect(data.revenue_by_account).toEqual([
      { account: '602', amount: 7000 },
      { account: '604', amount: 2500 },
    ]);
    expect(data.expenses_by_account).toEqual([
      { account: '521', amount: 6000 },
      { account: '518', amount: 3500 },
    ]);
    const ledger = requests.filter((r) => r.url.pathname === '/api/v1/accounting_records');
    expect(ledger).toHaveLength(4);
    expect(ledger.map((r) => r.url.searchParams.get('date_from'))).toEqual(Array(4).fill('2026-10-01'));
  });

  it('widens the window when more months are asked for', async () => {
    // act
    const { data } = await call('get_financial_overview', { months: 3 });

    // assert
    expect(data.months[0]).toEqual({ month: '2026-09', revenue: 7000, expenses: 0, profit: 7000 });
  });
});

describe('get_vat_overview', () => {
  it('uses the closing document for closed periods and estimates open ones from invoices', async () => {
    // act
    const { data } = await call('get_vat_overview');

    // assert
    expect(data.vat_period).toBe('quarterly');
    const [open, closed] = data.periods;
    expect(closed).toMatchObject({
      period: '2026-Q3',
      output_vat: 22200,
      input_vat: 8400,
      to_pay: 13800,
      source: 'closing_document',
      preliminary: false,
      closing_document: '2026000050',
      due_date: '2026-10-25',
      days_left: -10,
    });
    // DEMO Q4: one standard invoice (+73.5), three corrective ones (−73.5, −1365, −1147.65), the proforma skipped
    expect(open).toMatchObject({
      period: '2026-Q4',
      start: '2026-10-01',
      end: '2026-12-31',
      output_vat: -2512.65,
      input_vat: 0,
      to_pay: -2512.65,
      source: 'invoices_estimate',
      preliminary: true,
      invoices_counted: { sales: 4, purchases: 0 },
      due_date: '2027-01-25',
      days_left: 82,
    });
  });
});

describe('get_bank_balances', () => {
  it('returns history only when asked', async () => {
    // act
    const { data } = await call('get_bank_balances', { history: true });

    // assert
    expect(data.accounts).toHaveLength(3);
    expect(data.history.map((h: Json) => h.as_of)).toEqual(['2026-11-01', '2026-11-01', '2026-10-01', '2026-10-01']);
    expect(data.note).toMatch(/snapshots/);
  });
});

describe('get_business_snapshot', () => {
  it('combines every section and reports no errors on a healthy tenant', async () => {
    // act
    const { result, data } = await call('get_business_snapshot');

    // assert
    expect(result.isError).toBeFalsy();
    expect(data.errors).toEqual([]);
    expect(data.company).toEqual({ name: 'DEMO, s. r. o.', vat_period: 'quarterly' });
    expect(data.this_month).toEqual({ month: '2026-11', revenue: -3000, expenses: -500, profit: -2500 });
    expect(data.previous_month.month).toBe('2026-10');
    expect(data.vat_current_period.period).toBe('2026-Q4');
    expect(data.receivables.totals.length).toBeGreaterThan(0);
    expect(data.receivables.most_overdue.length).toBeLessThanOrEqual(5);
    expect(data.documents_to_process).toBe(1);
    expect(data.bank.map((b: Json) => b.currency)).toEqual(['CZK', 'EUR']);
  });

  it('keeps going when one section fails', async () => {
    // arrange
    const { fetch } = fakeUolFetch();
    const failingBank: typeof fetch = async (input, init) =>
      String(input).includes('/bank_balances')
        ? new Response(JSON.stringify({ status: '401', code: '0002', message: 'Authentication failed.' }), { status: 401 })
        : fetch(input, init);
    client = await connect(demoConfig(tmpdir()), failingBank);

    // act
    const result = await client.callTool({ name: 'get_business_snapshot', arguments: {} });

    // assert
    const data = result.structuredContent as Json;
    expect(result.isError).toBeFalsy();
    expect(data.bank).toBeNull();
    expect(data.errors).toEqual([{ section: 'bank', message: expect.stringMatching(/0002/) }]);
    expect(data.company).not.toBeNull();
  });
});
