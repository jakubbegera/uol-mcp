import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { type AppConfig, DEMO } from '../../src/config.js';
import { createContext, createServer } from '../../src/server.js';
import { RateLimiter } from '../../src/uol/rate-limit.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

/** A response recorded from the DEMO tenant. */
export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, 'demo', `${name}.json`), 'utf8')) as T;
}

/** Hand-written data for endpoints whose DEMO responses are too large or empty. */
export function synthetic<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, 'synthetic', `${name}.json`), 'utf8')) as T;
}

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body, or form fields (files as `{ name, size, type }`). */
  body?: any;
}

/** A draft sales invoice the fake serves alongside the DEMO fixtures. */
export const DRAFT_INVOICE_ID = '2026900001';
/** An idempotency key the fake treats as already used. */
export const TAKEN_IDEMPOTENCY_KEY = 'taken-key';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const notFound = () => json(fixture('err_404_sales_invoice'), 404);

type Item = Record<string, unknown>;
type Body = { items?: Item[]; _meta?: { pagination?: Record<string, string> } };

/** Fixture list with the `next` link removed, so callers that page stop after one page. */
function singlePage(name: string, filter: (item: Item) => boolean = () => true): Body {
  const body = fixture<Body>(name);
  if (body._meta?.pagination) delete body._meta.pagination.next;
  return { ...body, items: (body.items ?? []).filter(filter) };
}

/** Serves [items] the way UOL pages them, honouring `page` / `per_page`. */
function paged(items: Item[], q: URLSearchParams): Body {
  const perPage = Number(q.get('per_page') ?? 100);
  const page = Number(q.get('page') ?? 1);
  const last = Math.max(1, Math.ceil(items.length / perPage));
  const link = (p: number) => `https://test.demo.uol.cz/api/v1/x?page=${p}&per_page=${perPage}`;
  return {
    items: items.slice((page - 1) * perPage, page * perPage),
    _meta: { pagination: { first: link(1), last: link(last), ...(page < last ? { next: link(page + 1) } : {}) } },
  };
}

/** `credit_account` / `debit_account` match by prefix on UOL; dates compare on the day. */
function ledgerRows(q: URLSearchParams): Item[] {
  const account = (row: Item, side: string) =>
    String((row[`${side}_account`] as { chart_of_account_id?: string } | undefined)?.chart_of_account_id ?? '');
  const day = (row: Item) => String(row.date ?? '').slice(0, 10);
  return (synthetic<Body>('accounting_records').items ?? []).filter(
    (row) =>
      (!q.get('credit_account') || account(row, 'credit').startsWith(q.get('credit_account')!)) &&
      (!q.get('debit_account') || account(row, 'debit').startsWith(q.get('debit_account')!)) &&
      (!q.get('date_from') || day(row) >= q.get('date_from')!) &&
      (!q.get('date_till') || day(row) <= q.get('date_till')!),
  );
}

async function readBody(body: RequestInit['body']): Promise<any> {
  if (typeof body === 'string') return JSON.parse(body);
  if (body instanceof FormData) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of body.entries()) {
      fields[key] =
        typeof value === 'string'
          ? value
          : { name: value.name, size: value.size, type: value.type, head: Buffer.from(await value.arrayBuffer()).subarray(0, 5).toString('latin1') };
    }
    return fields;
  }
  return undefined;
}

/** What UOL answers to a create: the stored invoice, draft unless `status: confirmed` was sent. */
function createdInvoice(body: any): Item {
  const detail = fixture<Item>('sales_invoice_detail');
  return {
    ...detail,
    invoice_id: 2026900002,
    public_id: '2026900002',
    status: body.status === 'confirmed' ? 'confirmed' : 'valid',
    type: body.type ?? 'standard',
    idempotency_key: body.idempotency_key,
    buyer: { _meta: { href: `https://test.demo.uol.cz/api/v1/contacts/${body.buyer_id}` } },
    note: body.note ?? null,
    items: (body.items ?? []).map((item: any, index: number) => ({ ...item, id: 9000 + index })),
  };
}

function patchedFields(body: any): Item {
  const { items: _items, tax_payment_date, ...rest } = body;
  return { ...rest, ...(tax_payment_date ? { tax_payment_date } : {}) };
}

/** UTF-8 bytes in a header value, as UOL sends them; fetch exposes them as Latin-1. */
const rawUtf8Header = (value: string) => Buffer.from(value, 'utf8').toString('latin1');

/**
 * A `fetch` that answers like the UOL DEMO tenant from the recorded fixtures,
 * plus a log of every request for assertions.
 */
export function fakeUolFetch(): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  // Pairings created through the fake, so a read-back sees them like on UOL.
  const pairings: Item[] = [];

  const route = (url: URL, accept: string | undefined, method: string, body: any): Response => {
    const path = url.pathname.replace(/^\/api/, '');
    const q = url.searchParams;
    const segments = path.split('/').filter(Boolean); // ["v1", resource, id?, sub?]
    const [, resource, id, sub] = segments;

    switch (resource) {
      case 'ping':
        return json(fixture('ping'));
      case 'my_companies':
        return json(fixture('my_companies'));
      case 'sales_invoices': {
        const detail = fixture<Item>('sales_invoice_detail');
        const draft = { ...detail, invoice_id: Number(DRAFT_INVOICE_ID), public_id: DRAFT_INVOICE_ID, status: 'valid' };
        if (!id && method === 'POST') {
          if (body.idempotency_key === TAKEN_IDEMPOTENCY_KEY) {
            return json(
              { message: 'Validation failed', errors: [{ resource: 'SalesInvoice', field: 'idempotency_key', code: 'has already been taken' }] },
              422,
            );
          }
          return json(createdInvoice(body), 201);
        }
        if (!id && q.get('idempotency_key') === TAKEN_IDEMPOTENCY_KEY) return json({ items: [detail] });
        if (!id) return json(singlePage('sales_invoices'));
        if (id === DRAFT_INVOICE_ID) {
          if (method === 'DELETE') return new Response(null, { status: 204 });
          return json(method === 'PATCH' ? { ...draft, ...patchedFields(body) } : draft);
        }
        if (id !== String(detail.invoice_id)) return notFound();
        if (method === 'PATCH') return json(fixture('err_404_sales_invoice'), 403);
        if (accept === 'application/pdf') {
          return new Response(Buffer.from('%PDF-1.4 fake'), { headers: { 'content-type': 'application/pdf' } });
        }
        if (accept === 'text/isdoc') {
          return new Response('<?xml version="1.0"?><Invoice><ID>2026000044</ID></Invoice>', {
            headers: { 'content-type': 'text/isdoc; charset=utf-8' },
          });
        }
        return json(detail);
      }
      case 'purchase_invoices': {
        const detail = fixture<Item>('purchase_invoice_detail');
        if (!id && method === 'POST') {
          if (body.idempotency_key === TAKEN_IDEMPOTENCY_KEY) {
            return json(
              { message: 'Validation failed', errors: [{ resource: 'PurchaseInvoice', field: 'idempotency_key', code: 'has already been taken' }] },
              422,
            );
          }
          return json(
            {
              ...detail,
              invoice_id: 2026900003,
              public_id: body.public_id,
              status: body.confirmed === 'true' ? 'confirmed' : 'valid',
              seller: { _meta: { href: `https://test.demo.uol.cz/api/v1/contacts/${body.seller_id}` } },
              items: body.items,
            },
            201,
          );
        }
        if (!id && q.get('idempotency_key') === TAKEN_IDEMPOTENCY_KEY) return json({ items: [detail] });
        if (!id) return json(singlePage('purchase_invoices'));
        return id === String(detail.invoice_id) ? json(detail) : notFound();
      }
      case 'demands_for_payment':
        return json({ reminder_id: 'U2026000001', status: body.status, items: body.items }, 201);
      case 'repairs':
        return json({ document_id: body.document_id, method: body.method ?? 'cancel' }, 201);
      case 'bank_movements':
        return method === 'POST' ? json({ gid: 1, ...body }, 201) : json(singlePage('bank_movements'));
      case 'petty_cash_incomes':
      case 'petty_cash_disburstments':
      case 'sales_orders':
      case 'purchase_orders':
        return json(singlePage(resource));
      case 'products': {
        if (!id) return json(singlePage('products'));
        const product = fixture<Body>('products').items?.find((p) => p.product_id === id);
        return product ? json(product) : notFound();
      }
      case 'warehouse':
        return id === 'statuses' ? json(singlePage('warehouse_statuses')) : notFound();
      case 'receivables': {
        const state = q.get('state');
        const contact = q.get('contact_id');
        const due = (i: Item) => Number(i.total_amount) - Number(i.paid_amount);
        if (id) {
          const row = fixture<Body>('receivables').items?.find((i) => String(i.invoice_id) === id);
          return row ? json(row) : notFound();
        }
        return json(
          singlePage('receivables', (i) => {
            if (contact && i.contact_id !== contact) return false;
            if (state === 'unpaid') return due(i) !== 0;
            if (state === 'paid') return due(i) === 0;
            return true;
          }),
        );
      }
      case 'contacts': {
        if (!id && method === 'POST') {
          return json({ contact_id: body.contact_id ?? 'novy_kontakt', status: 'valid', ...body }, 201);
        }
        if (!id) {
          const ico = q.get('company_number');
          return json(singlePage('contacts', (c) => !ico || c.company_number === ico));
        }
        if (id.startsWith('missing')) return notFound();
        const detail = fixture<Item>('contact_detail');
        if (id === detail.contact_id) return json(method === 'PATCH' ? { ...detail, ...body } : detail);
        const listed = fixture<Body>('contacts').items?.find((c) => c.contact_id === id);
        return listed ? json(listed) : json({ contact_id: id, name: `Name of ${id}` });
      }
      case 'accounting_records':
        return json(paged(ledgerRows(q), q));
      case 'internal_documents':
        return json(paged(synthetic<Body>('internal_documents').items ?? [], q));
      case 'bank_balances':
        return json(paged(synthetic<Body>('bank_balances').items ?? [], q));
      case 'uploaded_documents': {
        if (!id && method === 'POST') {
          if (body.file?.name === 'dup.pdf') {
            return json(
              { message: 'Validation failed', errors: [{ resource: 'UploadedDocument', field: 'file', code: "It's already uploaded. (43)" }] },
              422,
            );
          }
          return json({ id: 99, state: 'unprocessed', note: body.note ?? '', format: 'pdf' }, 201);
        }
        if (!id) {
          const state = q.get('state');
          const docs = (fixture<Body>('uploaded_documents').items ?? []).filter((d) => !state || d.state === state);
          return json(paged(docs, q));
        }
        if (sub === 'pairings' && method === 'POST') {
          pairings.push({ document_pairable_type: body.document_pairable_type, document_pairable_id: Number(body.document_pairable_id) });
          // UOL answers without the new pairing.
          return json(fixture('uploaded_document_pairings'), 201);
        }
        if (sub === 'pairings') return json({ ...fixture<Item>('uploaded_document_pairings'), document_pairings: pairings });
        if (sub === 'tags' && method === 'POST') return json({ id: 5, ...body }, 201);
        if (sub === 'tags' && method === 'DELETE') return new Response(null, { status: 204 });
        if (sub === 'tags') return json(fixture('err_401'), 401);
        if (method === 'PATCH') return json({ ...fixture<Item>('uploaded_document_detail'), state: body.state });
        if (sub === 'file') {
          return new Response(method === 'HEAD' ? null : Buffer.from('%PDF-1.4 doc'), {
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': `inline; filename="${rawUtf8Header('Faktura_vystavená_126125.pdf')}"`,
            },
          });
        }
        return json(fixture('uploaded_document_detail'));
      }
      case 'currencies':
      case 'countries':
      case 'departments':
      case 'my_bank_accounts':
        return json(singlePage(resource));
      default:
        return notFound();
    }
  };

  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const method = init?.method ?? 'GET';
    const body = await readBody(init?.body);
    requests.push({ url, method, headers, body });
    return route(url, headers.accept, method, body ?? {});
  };

  return { fetch: fakeFetch as typeof fetch, requests };
}

export const FIXED_NOW = new Date('2026-11-04T12:00:00Z');

export function demoConfig(downloadDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    credentials: { baseUrl: DEMO.baseUrl, email: DEMO.email, token: DEMO.token, isDemo: true },
    downloadDir,
    requestTimeoutMs: 5_000,
    debug: false,
    ...overrides,
  };
}

/** An MCP client connected in-memory to a server backed by [fetchImpl]. */
export async function connect(config: AppConfig, fetchImpl?: typeof fetch): Promise<Client> {
  const limiter = new RateLimiter({ general: { requests: 1_000, windowMs: 1 }, receivables: { requests: 1_000, windowMs: 1 } });
  const ctx = createContext(config, { fetch: fetchImpl, limiter, now: () => FIXED_NOW });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(ctx).connect(serverTransport);
  const client = new Client({ name: 'uol-mcp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}
