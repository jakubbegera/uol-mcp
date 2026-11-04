import { mkdtempSync } from 'node:fs';
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

async function setup(access: AppConfig['access'] = 'write') {
  const dir = mkdtempSync(join(tmpdir(), 'uol-mcp-writes-more-'));
  const { fetch, requests } = fakeUolFetch();
  client = await connect(demoConfig(dir, { access, auditLog: join(dir, 'audit.jsonl') }), fetch);
  const call = async (name: string, args: Json) => {
    const result = await client!.callTool({ name, arguments: args });
    return { result, data: result.structuredContent as Json, text: JSON.stringify(result.content) };
  };
  const writes = () => requests.filter((r) => !['GET', 'HEAD'].includes(r.method));
  return { call, writes };
}

describe('contacts', () => {
  it('create_contact refuses a duplicate IČO unless asked', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const blocked = await call('create_contact', { name: 'ACTIVE 24', company_number: '25115804' });
    const allowed = await call('create_contact', { name: 'ACTIVE 24', company_number: '25115804', allow_duplicate: true, dry_run: true });

    // assert
    expect(blocked.text).toMatch(/already exists: ACTIVE 24, s\.r\.o\. \(active_24_sro\)/);
    expect(allowed.data.dry_run).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('create_contact builds an accounting address and sends booleans as strings', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { data } = await call('create_contact', {
      name: 'Jan Novák',
      taxable_person: false,
      city: 'Brno',
      email: 'jan@example.com',
      days_till_due_date: 14,
    });

    // assert
    expect(writes()[0]?.body).toEqual({
      name: 'Jan Novák',
      taxable_person: 'false',
      country_id: 'CZ',
      days_till_due_date: '14',
      addresses: [{ name: 'Jan Novák', city: 'Brno', country_id: 'CZ', email: 'jan@example.com', address_types: ['accounting'] }],
    });
    expect(data.contact).toMatchObject({ contact_id: 'novy_kontakt', name: 'Jan Novák' });
  });

  it('update_contact patches the existing accounting address', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    await call('update_contact', { contact_id: 'active_24_sro', email: 'fakturace@active24.cz', days_till_due_date: 30 });

    // assert
    expect(writes()[0]?.body).toEqual({
      days_till_due_date: '30',
      addresses: [{ address_id: 'praha_8_sokolovska_394', email: 'fakturace@active24.cz' }],
    });
  });
});

describe('create_purchase_invoice', () => {
  const items = [{ description: 'Kancelářské potřeby', total_price: 1000, vat_rate: 21, product_id: 'drmaj' }];
  const bank = { bank_account: '1014977044/3030', variable_symbol: 124 };

  it('checks the supplier and books the invoice with line totals', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const missing = await call('create_purchase_invoice', { seller_id: 'missing_supplier', number: 'X1', items, ...bank });
    const { data } = await call('create_purchase_invoice', { seller_id: 'alzacz_as', number: 'X00124', items, ...bank, confirm: true });

    // assert
    expect(missing.text).toMatch(/No contact with id missing_supplier/);
    expect(writes()[0]?.body).toMatchObject({
      seller_id: 'alzacz_as',
      public_id: 'X00124',
      confirmed: 'true',
      iban_or_account: '1014977044/3030',
      bank_country_id: 'CZ',
      variable_symbol: 124,
      items: [
        { description: 'Kancelářské potřeby', quantity: 1, total_price: 1000, vat_rate: 21, vat_calculation_method: 'from_below', product_id: 'drmaj' },
      ],
    });
    expect(data.invoice).toMatchObject({ invoice_id: '2026900003', number: 'X00124', status: 'issued' });
  });

  it('asks for the bank details a bank-transfer invoice needs, before sending', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const noAccount = await call('create_purchase_invoice', { seller_id: 'alzacz_as', number: 'X1', items, variable_symbol: 1 });
    const cash = await call('create_purchase_invoice', { seller_id: 'alzacz_as', number: 'X2', items, payment_method: 'cash', dry_run: true });
    const iban = await call('create_purchase_invoice', {
      seller_id: 'alzacz_as',
      number: 'X3',
      items,
      bank_account: 'CZ4930300000001014977044',
      variable_symbol: 1,
      dry_run: true,
    });

    // assert
    expect(noAccount.text).toMatch(/needs bank_account/);
    expect(cash.data.dry_run).toBe(true);
    expect(iban.data.payload).toMatchObject({ iban_or_account: 'CZ4930300000001014977044' });
    expect(iban.data.payload).not.toHaveProperty('bank_country_id');
    expect(writes()).toEqual([]);
  });

  it('returns the earlier invoice for a reused idempotency key', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { data } = await call('create_purchase_invoice', {
      seller_id: 'alzacz_as',
      number: 'X1',
      items,
      ...bank,
      idempotency_key: TAKEN_IDEMPOTENCY_KEY,
    });

    // assert
    expect(data).toMatchObject({ already_existed: true, invoice: { invoice_id: '2014000001' } });
  });
});

describe('create_payment_demand', () => {
  it('accepts unpaid invoices of one customer and never e-mails', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { data } = await call('create_payment_demand', { invoice_ids: ['2026000037', '2026000029'], note: 'Upomínka' });

    // assert
    expect(data.invoices).toEqual([
      { invoice_id: '2026000037', customer_id: 'active_24_sro', outstanding: 210 },
      { invoice_id: '2026000029', customer_id: 'active_24_sro', outstanding: 121 },
    ]);
    expect(writes()[0]?.body).toEqual({
      contact_id: 'active_24_sro',
      note: 'Upomínka',
      status: 'valid',
      send_by_email: 'false',
      send_by_mail: 'false',
      items: [{ invoice_id: '2026000037' }, { invoice_id: '2026000029' }],
    });
    expect(data.demand).toMatchObject({ reminder_id: 'U2026000001' });
  });

  it('refuses paid invoices and mixed customers', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const paid = await call('create_payment_demand', { invoice_ids: ['2017000019'] });
    const mixed = await call('create_payment_demand', { invoice_ids: ['2026000037', '2026000044'] });

    // assert
    expect(paid.text).toMatch(/is not unpaid/);
    expect(mixed.text).toMatch(/one customer/);
    expect(writes()).toEqual([]);
  });
});

describe('uploaded document workflow', () => {
  it('marks a document processed', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { data } = await call('mark_document_processed', { document_id: '4' });

    // assert
    expect(writes()[0]).toMatchObject({ method: 'PATCH', body: { state: 'processed' } });
    expect(data.state).toBe('processed');
  });

  it('pairs with a purchase invoice by resolving its gid', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const { data } = await call('pair_uploaded_document', {
      document_id: '4',
      target_type: 'purchase_invoice',
      target_invoice_id: '2014000001',
    });

    // assert
    expect(writes()[0]?.body).toEqual({ document_pairable_type: 'purchase_invoice', document_pairable_id: '64919' });
    expect(data.pairings).toEqual([{ type: 'purchase_invoice', gid: 64919 }]);
  });

  it('needs a gid for petty-cash pairings', async () => {
    // arrange
    const { call } = await setup();

    // act
    const { text } = await call('pair_uploaded_document', { document_id: '4', target_type: 'petty_cash_income', target_invoice_id: '1' });

    // assert
    expect(text).toMatch(/target_gid/);
  });

  it('adds and removes tags', async () => {
    // arrange
    const { call, writes } = await setup();

    // act
    const added = await call('tag_uploaded_document', { document_id: '4', tag_type: 'receipt', number: '6/2026' });
    await call('untag_uploaded_document', { document_id: '4', tag_id: '5' });

    // assert
    expect(added.data.tag).toMatchObject({ id: 5, tag_type: 'receipt', number: '6/2026' });
    expect(writes().map((w) => `${w.method} ${w.url.pathname}`)).toEqual([
      'POST /api/v1/uploaded_documents/4/tags',
      'DELETE /api/v1/uploaded_documents/4/tags/5',
    ]);
  });
});

describe('destructive tools (UOL_ACCESS=full)', () => {
  it('delete_sales_invoice deletes drafts and refuses issued invoices', async () => {
    // arrange
    const { call, writes } = await setup('full');

    // act
    const issued = await call('delete_sales_invoice', { invoice_id: '2026000044' });
    const { data } = await call('delete_sales_invoice', { invoice_id: DRAFT_INVOICE_ID });

    // assert
    expect(issued.text).toMatch(/only drafts can be deleted/);
    expect(data).toMatchObject({ deleted: true, invoice_id: DRAFT_INVOICE_ID });
    expect(writes().map((w) => w.method)).toEqual(['DELETE']);
  });

  it('repair_sales_invoice sends an FO repair for issued invoices only', async () => {
    // arrange
    const { call, writes } = await setup('full');

    // act
    const draft = await call('repair_sales_invoice', { invoice_id: DRAFT_INVOICE_ID, method: 'cancel' });
    await call('repair_sales_invoice', { invoice_id: '2026000044', method: 'disconfirm', reason: 'Špatná splatnost' });

    // assert
    expect(draft.text).toMatch(/not issued/);
    expect(writes()[0]?.body).toEqual({
      document_type: 'FO',
      document_id: '2026000044',
      method: 'disconfirm',
      reason: 'Špatná splatnost',
    });
  });

  it('api_request writes to any /v1 path and refuses others', async () => {
    // arrange
    const { call, writes } = await setup('full');

    // act
    const { data } = await call('api_request', { method: 'POST', path: '/v1/bank_movements', body: { amount: 100, locked: true } });
    const escape = await call('api_request', { method: 'DELETE', path: 'https://evil.example/v1/x' });
    const preview = await call('api_request', { method: 'DELETE', path: '/v1/contacts/x', dry_run: true });

    // assert
    expect(writes()[0]?.body).toEqual({ amount: 100, locked: 'true' });
    expect(data.response).toMatchObject({ gid: 1 });
    expect(escape.text).toMatch(/relative API path/);
    expect(preview.data).toMatchObject({ dry_run: true, response: null });
    expect(writes()).toHaveLength(1);
  });
});
