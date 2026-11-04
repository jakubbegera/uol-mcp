import { tmpdir } from 'node:os';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOLSETS } from '../src/config.js';
import { connect, demoConfig, fakeUolFetch } from './support/fake-uol.js';

type Json = Record<string, any>;

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function setup() {
  const { fetch, requests } = fakeUolFetch();
  client = await connect(demoConfig(tmpdir(), { toolsets: new Set(TOOLSETS) }), fetch);
  const call = async (name: string, args: Json = {}) => {
    const result = await client!.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return result.structuredContent as Json;
  };
  return { call, requests };
}

describe('optional toolsets', () => {
  it('are off by default and all present with UOL_TOOLSETS=all', async () => {
    // arrange
    const optional = ['search_accounting_records', 'list_bank_movements', 'search_products', 'list_orders'];
    client = await connect(demoConfig(tmpdir()));
    const byDefault = (await client.listTools()).tools.map((t) => t.name);
    await client.close();

    // act
    client = await connect(demoConfig(tmpdir(), { toolsets: new Set(TOOLSETS) }));
    const all = (await client.listTools()).tools.map((t) => t.name);

    // assert
    expect(byDefault).not.toEqual(expect.arrayContaining(optional.slice(0, 1)));
    expect(all).toEqual(expect.arrayContaining(optional));
    expect(all).toHaveLength(26);
  });
});

describe('ledger', () => {
  it('search_accounting_records passes prefix filters and returns home-currency amounts', async () => {
    // arrange
    const { call, requests } = await setup();

    // act
    const data = await call('search_accounting_records', { credit_account: '60', date_from: '2026-10-01' });

    // assert
    const query = requests.find((r) => r.url.pathname === '/api/v1/accounting_records')?.url.searchParams;
    expect(query?.get('credit_account')).toBe('60');
    expect(query?.get('date_from')).toBe('2026-10-01');
    expect(data.postings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ credit_account: '604000', amount: 2500, document_amount: 100, currency: 'EUR', posted: true }),
      ]),
    );
  });

  it('list_internal_documents filters by note and date, newest first', async () => {
    // arrange
    const { call } = await setup();

    // act
    const vat = await call('list_internal_documents', { note: 'dph' });
    const october = await call('list_internal_documents', { date_from: '2026-10-01' });

    // assert
    expect(vat.documents.map((d: Json) => d.number)).toEqual(['2026000050']);
    expect(vat.documents[0]).toMatchObject({ total: 44400, items_truncated: false });
    expect(october.documents.map((d: Json) => d.note)).toEqual(['Cestovné']);
  });
});

describe('banking', () => {
  it('list_bank_movements takes the date from the first part', async () => {
    // arrange
    const { call } = await setup();

    // act
    const data = await call('list_bank_movements', { limit: 3 });

    // assert
    expect(data.movements.length).toBeGreaterThan(0);
    const first = data.movements[0];
    expect(first.date).toBe(first.items[0]?.date ?? null);
    expect(typeof first.bank_account_id).toBe('string');
  });

  it('list_cash_documents reads incomes and disbursements', async () => {
    // arrange
    const { call, requests } = await setup();

    // act
    const incomes = await call('list_cash_documents', { kind: 'income' });
    const outgoing = await call('list_cash_documents', { kind: 'disbursement' });

    // assert
    expect(requests.map((r) => r.url.pathname)).toEqual(
      expect.arrayContaining(['/api/v1/petty_cash_incomes', '/api/v1/petty_cash_disburstments']),
    );
    expect(incomes.documents[0]).toMatchObject({ petty_cash_id: expect.any(String), gid: expect.any(Number) });
    expect(outgoing.documents[0].lines.length).toBeGreaterThan(0);
  });
});

describe('warehouse', () => {
  it('search_products, get_product, get_stock_levels and list_orders', async () => {
    // arrange
    const { call } = await setup();

    // act
    const products = await call('search_products', { query: 'obraz' });
    const product = await call('get_product', { product_id: 'konzultace' });
    const stock = await call('get_stock_levels', { quantity_less_than: 10 });
    const sales = await call('list_orders', { kind: 'sales' });
    const purchase = await call('list_orders', { kind: 'purchase' });

    // assert
    expect(products.products.map((p: Json) => p.product_id)).toContain('konzultace');
    expect(product.product).toMatchObject({ product_id: 'konzultace', name: 'konzultace' });
    expect(product.product).not.toHaveProperty('creator');
    expect(stock.stock[0]).toMatchObject({ product_id: expect.any(String), quantity: expect.any(Number) });
    expect(sales.orders[0]).toMatchObject({ contact_id: 'bychl_auto_as', items: [expect.objectContaining({ unit_price: 1000 })] });
    expect(purchase.orders[0].items[0]).toMatchObject({ total_price: 1 });
  });
});
