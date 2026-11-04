import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, demoConfig, fakeUolFetch } from './support/fake-uol.js';

type Json = Record<string, any>;

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function setup() {
  const downloadDir = mkdtempSync(join(tmpdir(), 'uol-mcp-test-'));
  const { fetch, requests } = fakeUolFetch();
  client = await connect(demoConfig(downloadDir), fetch);
  const call = async (name: string, args: Json = {}) => {
    const result = await client!.callTool({ name, arguments: args });
    return { result, data: result.structuredContent as Json };
  };
  return { call, requests, downloadDir };
}

const CORE_TOOLS = [
  'get_company',
  'list_codebook',
  'search_sales_invoices',
  'get_sales_invoice',
  'search_purchase_invoices',
  'get_purchase_invoice',
  'export_sales_invoice',
  'list_receivables',
  'search_contacts',
  'get_contact',
  'list_uploaded_documents',
  'get_uploaded_document',
  'download_uploaded_document',
  'api_get',
];
const INSIGHT_TOOLS = ['get_financial_overview', 'get_vat_overview', 'get_bank_balances', 'get_business_snapshot'];

describe('tools/list', () => {
  it('lists every tool in a stable order, all read-only', async () => {
    // arrange
    client = await connect(demoConfig(tmpdir()));

    // act
    const { tools } = await client.listTools();

    // assert
    expect(tools.map((t) => t.name)).toEqual([...CORE_TOOLS, ...INSIGHT_TOOLS]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it.each([
    ['core', CORE_TOOLS, ['overdue_followup', 'process_inbox']],
    ['insights', INSIGHT_TOOLS, ['monthly_review', 'vat_check']],
  ] as const)('registers only the %s toolset and its prompts', async (toolset, tools, prompts) => {
    // arrange
    client = await connect(demoConfig(tmpdir(), { toolsets: new Set([toolset]) }));

    // act
    const listed = await client.listTools();
    const listedPrompts = await client.listPrompts();

    // assert
    expect(listed.tools.map((t) => t.name)).toEqual(tools);
    expect(listedPrompts.prompts.map((p) => p.name)).toEqual(prompts);
  });
});

describe('resources and prompts', () => {
  it('serves the guide and the company as resources', async () => {
    // arrange
    const { fetch } = fakeUolFetch();
    client = await connect(demoConfig(tmpdir()), fetch);

    // act
    const { resources } = await client.listResources();
    const guide = await client.readResource({ uri: 'uol://guide' });
    const company = await client.readResource({ uri: 'uol://company' });

    // assert
    expect(resources.map((r) => r.uri)).toEqual(['uol://guide', 'uol://company']);
    expect((guide.contents[0] as { text: string }).text).toContain('get_business_snapshot');
    expect(JSON.parse((company.contents[0] as { text: string }).text)).toMatchObject({ name: 'DEMO, s. r. o.' });
  });

  it('fills prompt arguments into Czech instructions', async () => {
    // arrange
    client = await connect(demoConfig(tmpdir()));

    // act
    const review = await client.getPrompt({ name: 'monthly_review', arguments: { month: '2026-10' } });
    const followup = await client.getPrompt({ name: 'overdue_followup', arguments: {} });

    // assert
    expect((review.messages[0]?.content as { text: string }).text).toContain('měsíc 2026-10');
    expect((followup.messages[0]?.content as { text: string }).text).toContain('víc než 14 dní');
    expect((followup.messages[0]?.content as { text: string }).text).toContain('Nic neodesílej');
  });
});

describe('without credentials', () => {
  it('still lists tools and answers calls with setup instructions', async () => {
    // arrange
    client = await connect({ downloadDir: tmpdir(), requestTimeoutMs: 1_000, debug: false });

    // act
    const { tools } = await client.listTools();
    const result = await client.callTool({ name: 'get_company', arguments: {} });

    // assert
    expect(tools.length).toBeGreaterThan(0);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/UOL_TENANT/);
  });
});

describe('core tools against DEMO fixtures', () => {
  it('get_company resolves the current revision and VAT period', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { data } = await call('get_company');

    // assert
    expect(data).toMatchObject({
      name: 'DEMO, s. r. o.',
      company_number: '00000019',
      vatin: 'CZ00000019',
      vat_period: 'quarterly',
      tenant: { api_url: 'https://test.demo.uol.cz/api', demo: true },
    });
  });

  it('search_sales_invoices normalises rows and joins payment status', async () => {
    // arrange
    const { call, requests } = await setup();

    // act
    const { result, data } = await call('search_sales_invoices', { query: 'GATOM', limit: 5 });

    // assert
    expect(result.isError).toBeFalsy();
    const first = data.invoices[0];
    expect(first).toMatchObject({
      invoice_id: '2026000044',
      type: 'proforma',
      status: 'issued',
      total: 121,
      currency: 'CZK',
      buyer: { id: 'gatom_technicky_test_1' },
      payment: { state: 'unpaid', outstanding: 121 },
    });
    // 2026000042 is not among the unpaid receivables → paid
    expect(data.invoices.find((i: Json) => i.invoice_id === '2026000042').payment.state).toBe('paid');
    expect(data.pagination).toMatchObject({ page: 1, per_page: 5, has_more: false });
    const search = requests.find((r) => r.url.pathname === '/api/v1/sales_invoices');
    expect(search?.url.searchParams.get('q')).toBe('GATOM');
    expect(search?.url.searchParams.get('per_page')).toBe('5');
    // the JSON text block mirrors the structured content
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(data);
  });

  it('search_purchase_invoices maps DUZP filters to UOL parameter names', async () => {
    // arrange
    const { call, requests } = await setup();

    // act
    const { data } = await call('search_purchase_invoices', { tax_date_from: '2014-01-01', tax_date_to: '2014-12-31' });

    // assert
    expect(data.invoices[0]).toMatchObject({ invoice_id: '2014000001', total: 1210, vat: 210, total_without_vat: 1000 });
    const query = requests.find((r) => r.url.pathname === '/api/v1/purchase_invoices')?.url.searchParams;
    expect(query?.get('tax_payment_date_from')).toBe('2014-01-01');
    expect(query?.get('tax_payment_date_till')).toBe('2014-12-31');
  });

  it('get_sales_invoice includes items and payment status', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { data } = await call('get_sales_invoice', { invoice_id: '2026000044' });

    // assert
    expect(data.items[0]).toMatchObject({ quantity: 1, unit_price: 121, vat_rate: 0, product_id: 'zaloha_fo' });
    expect(data.payment).toEqual({ state: 'unpaid', outstanding: 121 });
    expect(data.buyer.id).toBe('gatom_technicky_test_1');
  });

  it('get_sales_invoice turns a 404 into a tool error', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { result } = await call('get_sales_invoice', { invoice_id: '1' });

    // assert
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/0004/);
  });

  it('list_receivables totals every match and sorts by days overdue', async () => {
    // arrange
    const { call, requests } = await setup();

    // act
    const { data } = await call('list_receivables', { overdue_only: true, limit: 3 });

    // assert
    expect(data.as_of).toBe('2026-11-04');
    expect(data.invoices).toHaveLength(3);
    expect(data.match_count).toBeGreaterThan(3);
    const days = data.invoices.map((i: Json) => i.days_overdue);
    expect(days).toEqual([...days].sort((a: number, b: number) => b - a));
    expect(data.invoices.every((i: Json) => i.days_overdue > 0 && i.outstanding > 0)).toBe(true);
    const czk = data.totals.find((t: Json) => t.currency === 'CZK');
    expect(czk.overdue_count).toBe(czk.count);
    expect(requests.find((r) => r.url.pathname === '/api/v1/receivables')?.url.searchParams.get('state')).toBe('unpaid');
  });

  it('search_contacts and get_contact expose IČO, DIČ, addresses and bank accounts', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { data: list } = await call('search_contacts', { query: 'active' });
    const { data: detail } = await call('get_contact', { contact_id: 'active_24_sro' });

    // assert
    expect(list.contacts[0]).toMatchObject({ contact_id: 'active_24_sro', company_number: '25115804', vatin: 'CZ25115804' });
    expect(detail.addresses[0]).toMatchObject({ city: 'Praha 8', street: 'Sokolovská 394/17' });
    expect(detail.bank_accounts[0]).toMatchObject({ iban: 'CZ6155000000000034175028', default: true });
  });

  it('uploaded documents: list, detail with decoded file name, download', async () => {
    // arrange
    const { call, downloadDir } = await setup();

    // act
    const { data: list } = await call('list_uploaded_documents', { state: 'unprocessed' });
    const { data: detail } = await call('get_uploaded_document', { document_id: '4' });
    const { result, data: saved } = await call('download_uploaded_document', { document_id: '4' });

    // assert
    expect(list.documents[0]).toMatchObject({ document_id: '4', state: 'unprocessed', uploaded_via: 'web' });
    expect(detail).toMatchObject({ file_name: 'Faktura_vystavená_126125.pdf', pairings: [], tags: null });
    expect(saved.file_path).toBe(join(downloadDir, 'Faktura_vystavená_126125.pdf'));
    expect(readFileSync(saved.file_path, 'utf8')).toBe('%PDF-1.4 doc');
    expect(result.content.some((c) => c.type === 'resource_link')).toBe(true);
  });

  it('export_sales_invoice negotiates the format with a single Accept header', async () => {
    // arrange
    const { call, requests } = await setup();

    // act
    const { data: pdf } = await call('export_sales_invoice', { invoice_id: '2026000044', format: 'pdf' });
    const { result: isdoc } = await call('export_sales_invoice', { invoice_id: '2026000044', format: 'isdoc' });

    // assert
    expect(pdf).toMatchObject({ file_name: 'faktura-2026000044.pdf', content_type: 'application/pdf' });
    const accepts = requests.filter((r) => r.url.pathname.endsWith('/2026000044')).map((r) => r.headers.accept);
    expect(accepts).toEqual(['application/pdf', 'text/isdoc']);
    expect(JSON.stringify(isdoc.content)).toContain('<Invoice>');
  });

  it('list_codebook strips audit fields', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { data } = await call('list_codebook', { kind: 'currencies', limit: 5 });

    // assert
    expect(data.items[0]).toMatchObject({ currency_id: 'AED', name: 'Dirham SAE' });
    expect(data.items[0]).not.toHaveProperty('creator');
  });

  it('api_get fetches arbitrary /v1 paths and rejects anything else', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { data } = await call('api_get', { path: '/v1/products', query: { per_page: 1 } });
    const { result: escaped } = await call('api_get', { path: 'https://evil.example/v1/x' });
    const { result: traversal } = await call('api_get', { path: '/v1/../admin' });

    // assert
    expect(data).toMatchObject({ path: '/v1/products', truncated: false });
    expect(data.data.items[0].product_id).toBe('konzultace');
    expect(escaped.isError).toBe(true);
    expect(traversal.isError).toBe(true);
  });
});
