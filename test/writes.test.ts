import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { DRAFT_INVOICE_ID, TAKEN_IDEMPOTENCY_KEY, connect, demoConfig, fakeUolFetch } from './support/fake-uol.js';

type Json = Record<string, any>;

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'uol-mcp-writes-'));
  const auditLog = join(dir, 'audit.jsonl');
  return { dir, auditLog };
}

async function setup(overrides: Partial<AppConfig> = {}) {
  const { dir, auditLog } = workspace();
  const { fetch, requests } = fakeUolFetch();
  client = await connect(demoConfig(dir, { access: 'write', uploadDirs: [dir], auditLog, ...overrides }), fetch);
  const call = async (name: string, args: Json) => {
    const result = await client!.callTool({ name, arguments: args });
    return { result, data: result.structuredContent as Json, text: JSON.stringify(result.content) };
  };
  const writes = () => requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
  const auditLines = () => readFileSync(auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { call, requests, writes, auditLines, dir };
}

describe('access levels', () => {
  it('registers no write tools by default', async () => {
    // arrange
    client = await connect(demoConfig(tmpdir()));

    // act
    const { tools } = await client.listTools();

    // assert
    expect(tools.some((t) => t.annotations?.readOnlyHint === false)).toBe(false);
  });

  it('adds the write tools with UOL_ACCESS=write, annotated for host confirmation', async () => {
    // arrange
    client = await connect(demoConfig(tmpdir(), { access: 'write' }));

    // act
    const { tools } = await client.listTools();

    // assert
    const writes = Object.fromEntries(
      tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => [t.name, t.annotations?.destructiveHint]),
    );
    expect(writes).toEqual({
      upload_document: false,
      create_sales_invoice: true,
      update_sales_invoice: true,
      create_contact: false,
      update_contact: true,
      create_purchase_invoice: false,
      create_payment_demand: false,
      mark_document_processed: false,
      pair_uploaded_document: false,
      tag_uploaded_document: false,
      untag_uploaded_document: true,
    });
  });

  it('adds the destructive tools only with UOL_ACCESS=full', async () => {
    // arrange
    client = await connect(demoConfig(tmpdir(), { access: 'full' }));

    // act
    const { tools } = await client.listTools();

    // assert
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['delete_sales_invoice', 'repair_sales_invoice', 'api_request']));
    for (const name of ['delete_sales_invoice', 'repair_sales_invoice', 'api_request']) {
      expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint, name).toBe(true);
    }
  });
});

describe('create_sales_invoice', () => {
  const items = [
    { description: 'Konzultace', quantity: 2, unit_price: 1500, vat_rate: 21, product_id: 'konzultace' },
    { description: 'Licence', unit_price_with_vat: 1210, product_id: 'licence' },
  ];

  it('dry_run validates the buyer and shows the payload without writing', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { data } = await call('create_sales_invoice', { buyer_id: 'alzacz_as', items, dry_run: true });

    // assert
    expect(writes()).toEqual([]);
    expect(data).toMatchObject({ dry_run: true, buyer: { id: 'alzacz_as', name: 'Alza.cz a.s.' }, invoice: null });
    expect(data.payload.items).toEqual([
      { description: 'Konzultace', quantity: 2, unit_price: 1500, vat_calculation_method: 'from_below', vat_rate: 21, product_id: 'konzultace' },
      { description: 'Licence', quantity: 1, unit_price_vat_inclusive: 1210, vat_calculation_method: 'from_above', product_id: 'licence' },
    ]);
    expect(data.payload).not.toHaveProperty('status');
    expect(data.payload).not.toHaveProperty('public_id');
    expect(data.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends a given invoice number as public_id', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { data } = await call('create_sales_invoice', { buyer_id: 'alzacz_as', items, number: ' 2026000050 ', dry_run: true });

    // assert
    expect(writes()).toEqual([]);
    expect(data.payload.public_id).toBe('2026000050');
  });

  it('refuses a number another invoice already has, before sending anything', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { result, text } = await call('create_sales_invoice', { buyer_id: 'alzacz_as', items, number: '2026000044', dry_run: true });

    // assert
    expect(result.isError).toBe(true);
    expect(text).toMatch(/already used by invoice 2026000044/);
    expect(writes()).toEqual([]);
  });

  it('rejects a blank number', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { result } = await call('create_sales_invoice', { buyer_id: 'alzacz_as', items, number: '   ', dry_run: true });

    // assert
    expect(result.isError).toBe(true);
  });

  it('creates a draft, sends booleans as strings and writes the audit log', async () => {
    // arrange
    const { call, writes, auditLines } = await setup();

    // act
    const { data } = await call('create_sales_invoice', {
      buyer_id: 'alzacz_as',
      items,
      tax_date: '2026-11-04',
      note: 'Díky',
      idempotency_key: 'k-1',
    });

    // assert
    const [post] = writes();
    expect(post?.url.pathname).toBe('/api/v1/sales_invoices');
    expect(post?.headers['content-type']).toBe('application/json');
    expect(post?.body).toMatchObject({ buyer_id: 'alzacz_as', tax_payment_date: '2026-11-04', note: 'Díky', idempotency_key: 'k-1' });
    expect(data.invoice).toMatchObject({ invoice_id: '2026900002', status: 'draft', buyer: { id: 'alzacz_as' } });
    expect(data.invoice.items.map((i: Json) => i.item_id)).toEqual([9000, 9001]);
    expect(auditLines()).toEqual([
      expect.objectContaining({ tool: 'create_sales_invoice', outcome: 'ok', result_id: '2026900002', idempotency_key: 'k-1' }),
    ]);
    expect(auditLines()[0].payload_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('issues right away with issue=true', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { data } = await call('create_sales_invoice', { buyer_id: 'alzacz_as', items, issue: true });

    // assert
    expect(writes()[0]?.body.status).toBe('confirmed');
    expect(data.invoice.status).toBe('issued');
  });

  it('returns the existing invoice when the idempotency key was already used', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { data } = await call('create_sales_invoice', { buyer_id: 'alzacz_as', items, idempotency_key: TAKEN_IDEMPOTENCY_KEY });

    // assert
    expect(data).toMatchObject({ already_existed: true, invoice: { invoice_id: '2026000044' } });
  });

  it('requires a product on every line, as UOL does', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { result } = await call('create_sales_invoice', { buyer_id: 'alzacz_as', items: [{ description: 'x', unit_price: 1 }] });

    // assert
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/product_id/);
    expect(writes()).toEqual([]);
  });

  it('rejects an item with both or neither price', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { result } = await call('create_sales_invoice', {
      buyer_id: 'alzacz_as',
      items: [{ description: 'x', unit_price: 1, unit_price_with_vat: 2, product_id: 'p' }],
    });

    // assert
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/exactly one of unit_price or unit_price_with_vat/);
  });
});

describe('update_sales_invoice', () => {
  it('patches only the given fields of a draft', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { data } = await call('update_sales_invoice', {
      invoice_id: DRAFT_INVOICE_ID,
      due_date: '2026-12-01',
      add_items: [{ description: 'Doprava', unit_price: 200, product_id: 'doprava' }],
      remove_item_ids: [2825626],
      issue: true,
    });

    // assert
    const [patch] = writes();
    expect(patch?.method).toBe('PATCH');
    expect(patch?.body).toEqual({
      due_date: '2026-12-01',
      status: 'confirmed',
      items: [
        { description: 'Doprava', quantity: 1, unit_price: 200, vat_calculation_method: 'from_below', product_id: 'doprava' },
        { id: 2825626, _destroy: 1 },
      ],
    });
    expect(data.invoice.status).toBe('issued');
  });

  it('renumbers a draft through number and variable_symbol', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { data } = await call('update_sales_invoice', { invoice_id: DRAFT_INVOICE_ID, number: '2026000050', variable_symbol: 2026000050 });

    // assert
    const [patch] = writes();
    expect(patch?.method).toBe('PATCH');
    expect(patch?.body).toEqual({ public_id: '2026000050', variable_symbol: 2026000050 });
    expect(data.invoice).toMatchObject({ invoice_id: DRAFT_INVOICE_ID, number: '2026000050' });
  });

  it('refuses an issued invoice before sending anything', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { result, text } = await call('update_sales_invoice', { invoice_id: '2026000044', note: 'x' });

    // assert
    expect(result.isError).toBe(true);
    expect(text).toMatch(/already issued/);
    expect(writes()).toEqual([]);
  });

  it('refuses a call that changes nothing', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { text } = await call('update_sales_invoice', { invoice_id: DRAFT_INVOICE_ID });

    // assert
    expect(text).toMatch(/Nothing to change/);
  });
});

describe('upload_document', () => {
  const pdf = Buffer.from('%PDF-1.7\n%test\n');

  it('uploads a PDF from an allowed folder as multipart', async () => {
    // arrange
    const { call, writes, dir, auditLines } = await setup();
    writeFileSync(join(dir, 'účtenka.pdf'), pdf);

    // act
    const { data } = await call('upload_document', { file_path: join(dir, 'účtenka.pdf'), note: 'Středisko Praha' });

    // assert
    expect(writes()[0]?.body).toEqual({
      file: { name: 'účtenka.pdf', size: pdf.length, type: 'application/pdf', head: '%PDF-' },
      note: 'Středisko Praha',
    });
    expect(data).toMatchObject({ dry_run: false, document_id: '99', state: 'unprocessed', file_name: 'účtenka.pdf' });
    expect(auditLines()[0]).toMatchObject({ tool: 'upload_document', outcome: 'ok', result_id: '99' });
  });

  it('accepts base64 content', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { data } = await call('upload_document', { content_base64: pdf.toString('base64'), file_name: 'scan.pdf' });

    // assert
    expect(data).toMatchObject({ document_id: '99', size_bytes: pdf.length });
  });

  it('names the existing document when UOL already has the file', async () => {
    // arrange
    const { call, dir, auditLines } = await setup();
    writeFileSync(join(dir, 'dup.pdf'), pdf);

    // act
    const { result, text } = await call('upload_document', { file_path: join(dir, 'dup.pdf') });

    // assert
    expect(result.isError).toBe(true);
    expect(text).toMatch(/already has this file as uploaded document 43/);
    expect(auditLines()[0]).toMatchObject({ outcome: 'error' });
  });

  it('refuses files outside the upload folders and non-PDFs, without writing', async () => {
    // arrange
    const { call, writes, dir } = await setup();
    writeFileSync(join(dir, 'notes.pdf'), 'plain text');

    // act
    const outside = await call('upload_document', { file_path: '/etc/hosts' });
    const fake = await call('upload_document', { file_path: join(dir, 'notes.pdf') });
    const both = await call('upload_document', { file_path: join(dir, 'notes.pdf'), content_base64: 'eA==' });

    // assert
    expect(outside.text).toMatch(/outside the folders/);
    expect(fake.text).toMatch(/does not look like a PDF/);
    expect(both.text).toMatch(/exactly one of file_path or content_base64/);
    expect(writes()).toEqual([]);
  });
});
