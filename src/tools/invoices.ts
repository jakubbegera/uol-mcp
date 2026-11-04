import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { safeFileName } from '../domain/files.js';
import { type Payment, paymentOfReceivable } from '../domain/receivables.js';
import type { RawInvoiceItem, RawPurchaseInvoice, RawSalesInvoice } from '../uol/client.js';
import { UolApiError } from '../uol/errors.js';
import { amount, hrefId, invoiceStatus, money, pageInfo, refId, str } from '../uol/normalize.js';
import { type ToolContext, registerReadTool } from './context.js';
import { deliverFile } from './files.js';
import {
  invoiceItem,
  invoiceStatus as statusSchema,
  invoiceType,
  isoDate,
  limitArg,
  pageArg,
  pageInfo as pageInfoSchema,
  party,
  savedFile,
} from './schemas.js';

const payment = z.object({
  state: z
    .enum(['paid', 'unpaid', 'partially_paid', 'not_applicable', 'unknown'])
    .describe('From /v1/receivables; not_applicable for drafts and cancelled invoices'),
  outstanding: z.number().nullable().describe('Still due; negative = credit note not yet settled'),
});

const amounts = {
  total: z.number().nullable().describe('Total including VAT (Celkem s DPH)'),
  vat: z.number().nullable().describe('Sum of VAT amounts'),
  total_without_vat: z.number().nullable().describe('Tax base (Celkem bez DPH)'),
  currency: z.string().nullable(),
};

export const salesRow = z.object({
  invoice_id: z.string().describe('Internal id, usable with get_sales_invoice'),
  number: z.string().nullable().describe('Evidence number shown on the invoice'),
  type: z.string().nullable(),
  status: statusSchema,
  issue_date: z.string().nullable(),
  tax_date: z.string().nullable().describe('DUZP — taxable supply date'),
  due_date: z.string().nullable(),
  ...amounts,
  buyer: party,
  variable_symbol: z.string().nullable(),
  payment,
});

const purchaseRow = z.object({
  invoice_id: z.string().describe('Internal id, usable with get_purchase_invoice'),
  number: z.string().nullable().describe("Supplier's invoice number"),
  type: z.string().nullable(),
  status: statusSchema,
  issue_date: z.string().nullable(),
  tax_date: z.string().nullable().describe('DUZP — taxable supply date'),
  received_date: z.string().nullable(),
  due_date: z.string().nullable(),
  ...amounts,
  seller: party,
  variable_symbol: z.string().nullable(),
});

export const commonDetail = {
  vat_amounts: z.array(z.number().nullable()).describe('UOL vat1..vat3 amounts in rate order'),
  payment_method: z.string().nullable(),
  constant_symbol: z.string().nullable(),
  specific_symbol: z.string().nullable(),
  exchange_rate: z.number().nullable(),
  department_id: z.string().nullable(),
  external_id: z.string().nullable(),
  note: z.string().nullable(),
  items: z.array(invoiceItem),
};

function totals(raw: RawSalesInvoice | RawPurchaseInvoice) {
  const vats = [raw.vat1_amount, raw.vat2_amount, raw.vat3_amount].map(amount);
  const total = amount(raw.total_amount);
  const vat = money(vats.reduce<number>((sum, v) => sum + (v ?? 0), 0));
  return {
    total,
    vat,
    total_without_vat: total === null ? null : money(total - vat),
    currency: refId(raw.currency, 'currency_id'),
    vats,
  };
}

function items(raw: RawInvoiceItem[] | undefined) {
  return (raw ?? []).map((item) => ({
    item_id: item.id ?? null,
    description: str(item.description),
    quantity: amount(item.quantity),
    unit_price: amount(item.unit_price),
    unit_price_with_vat: amount(item.unit_price_vat_inclusive),
    vat_rate: amount(item.vat_rate),
    discount_percent: amount(item.percent_discount),
    product_id: refId(item.product, 'product_id'),
  }));
}

export function salesRowOf(raw: RawSalesInvoice, names: Map<string, string | null>, pay: Payment) {
  const { vats: _vats, ...money } = totals(raw);
  const buyerId = hrefId(raw.buyer);
  return {
    invoice_id: String(raw.invoice_id ?? ''),
    number: str(raw.public_id),
    type: str(raw.type),
    status: invoiceStatus(raw.status),
    issue_date: str(raw.issue_date),
    tax_date: str(raw.tax_payment_date),
    due_date: str(raw.due_date),
    ...money,
    buyer: { id: buyerId, name: buyerId ? (names.get(buyerId) ?? null) : null },
    variable_symbol: str(raw.variable_symbol),
    payment: pay,
  };
}

function purchaseRowOf(raw: RawPurchaseInvoice, names: Map<string, string | null>) {
  const { vats: _vats, ...money } = totals(raw);
  const sellerId = hrefId(raw.seller);
  return {
    invoice_id: String(raw.invoice_id ?? ''),
    number: str(raw.public_id),
    type: str(raw.type),
    status: invoiceStatus(raw.status),
    issue_date: str(raw.issue_date),
    tax_date: str(raw.tax_payment_date),
    received_date: str(raw.date_of_receipt),
    due_date: str(raw.due_date),
    ...money,
    seller: { id: sellerId, name: sellerId ? (names.get(sellerId) ?? null) : null },
    variable_symbol: str(raw.variable_symbol),
  };
}

export function detailOf(raw: RawSalesInvoice | RawPurchaseInvoice) {
  return {
    vat_amounts: totals(raw).vats,
    payment_method: str(raw.payment_method),
    constant_symbol: str(raw.constant_symbol),
    specific_symbol: str(raw.specific_symbol),
    exchange_rate: amount(raw.exchange_rate),
    department_id: refId(raw.department, 'department_id'),
    external_id: str(raw.external_id),
    note: str(raw.note),
    items: items(raw.items),
  };
}

export function registerInvoiceTools(server: McpServer, ctx: ToolContext): void {
  registerReadTool(
    server,
    ctx,
    'search_sales_invoices',
    {
      title: 'Search issued invoices',
      description:
        'Search issued (sales) invoices — vydané faktury — newest first. Each row includes payment status from UOL receivables. ' +
        'Use tax_date_* (DUZP) for accounting-period questions, issue_date_* for "issued in". ' +
        'For "who owes me money" prefer list_receivables.',
      input: z.object({
        query: z.string().optional().describe('Full-text: invoice number, buyer name or text'),
        buyer_id: z.string().optional().describe('Contact id from search_contacts'),
        number: z.string().optional().describe('Partial match of the invoice number'),
        variable_symbol: z.string().optional(),
        type: invoiceType.optional(),
        issue_date_from: isoDate.optional(),
        issue_date_to: isoDate.optional(),
        tax_date_from: isoDate.optional(),
        tax_date_to: isoDate.optional(),
        due_date_from: isoDate.optional(),
        due_date_to: isoDate.optional(),
        total_min: z.number().optional().describe('Total including VAT'),
        total_max: z.number().optional(),
        page: pageArg,
        limit: limitArg(),
      }),
      output: z.object({ invoices: z.array(salesRow), pagination: pageInfoSchema }),
    },
    async (args, { client, contacts, unpaid }) => {
      const body = await client.salesInvoices({
        q: args.query,
        buyer_id: args.buyer_id,
        public_id: args.number,
        variable_symbol: args.variable_symbol,
        type: args.type,
        issue_date_from: args.issue_date_from,
        issue_date_till: args.issue_date_to,
        tax_payment_date_from: args.tax_date_from,
        tax_payment_date_till: args.tax_date_to,
        due_date_from: args.due_date_from,
        due_date_till: args.due_date_to,
        total_min: args.total_min,
        total_max: args.total_max,
        page: args.page,
        per_page: args.limit,
      });
      const raws = body.items ?? [];
      const names = await contacts.resolve(raws.map((r) => hrefId(r.buyer)));
      const invoices = await Promise.all(
        raws.map(async (raw) => {
          const id = String(raw.invoice_id ?? '');
          const pay = await unpaid.paymentOf(id, raw.status === 'confirmed', amount(raw.total_amount));
          return salesRowOf(raw, names, pay);
        }),
      );
      return { data: { invoices, pagination: pageInfo(body, args.page, args.limit) } };
    },
  );

  registerReadTool(
    server,
    ctx,
    'get_sales_invoice',
    {
      title: 'Get issued invoice',
      description:
        'One issued (sales) invoice with line items, VAT, payment symbols and payments received. ' +
        'Use export_sales_invoice for the PDF or ISDOC.',
      input: z.object({ invoice_id: z.string().describe('invoice_id from search_sales_invoices') }),
      output: salesRow.extend({
        ...commonDetail,
        text: z.string().nullable().describe('Introductory text printed on the invoice'),
        linked_invoice_id: z.string().nullable().describe('E.g. the original invoice of a corrective invoice'),
        payments: z.array(z.object({ date: z.string().nullable(), amount: z.number().nullable(), currency: z.string().nullable() })),
      }),
    },
    async ({ invoice_id }, { client, contacts }) => {
      const raw = await client.salesInvoice(invoice_id);
      const issued = raw.status === 'confirmed';
      const receivable = issued
        ? await client.receivable(invoice_id).catch((error: unknown) => {
            if (error instanceof UolApiError && error.status === 404) return undefined;
            throw error;
          })
        : undefined;
      const pay: Payment = !issued
        ? { state: 'not_applicable', outstanding: null }
        : receivable
          ? paymentOfReceivable(receivable)
          : { state: 'unknown', outstanding: null };
      const names = await contacts.resolve([hrefId(raw.buyer)]);
      return {
        data: {
          ...salesRowOf(raw, names, pay),
          ...detailOf(raw),
          text: str(raw.text),
          linked_invoice_id: hrefId(raw.linked_doc ?? undefined) ?? str(raw.linked_doc_number),
          payments: (receivable?.payments ?? []).map((p) => ({
            date: str(p.timestamp)?.slice(0, 10) ?? null,
            amount: amount(p.amount),
            currency: str(p.currency_id),
          })),
        },
      };
    },
  );

  registerReadTool(
    server,
    ctx,
    'search_purchase_invoices',
    {
      title: 'Search received invoices',
      description:
        'Search received (purchase) invoices — přijaté faktury. UOL ignores issue-date filters on this endpoint, ' +
        'so filter by tax_date_* (DUZP) or received_date_*. The UOL API exposes no payment status for purchase invoices.',
      input: z.object({
        query: z.string().optional().describe('Full-text: invoice number, supplier name or text'),
        seller_id: z.string().optional().describe('Contact id from search_contacts'),
        number: z.string().optional().describe("Partial match of the supplier's invoice number"),
        variable_symbol: z.string().optional(),
        type: invoiceType.optional(),
        tax_date_from: isoDate.optional(),
        tax_date_to: isoDate.optional(),
        received_date_from: isoDate.optional(),
        received_date_to: isoDate.optional(),
        due_date_from: isoDate.optional(),
        due_date_to: isoDate.optional(),
        total_min: z.number().optional(),
        total_max: z.number().optional(),
        currency: z.string().optional().describe('ISO code, e.g. EUR'),
        page: pageArg,
        limit: limitArg(),
      }),
      output: z.object({ invoices: z.array(purchaseRow), pagination: pageInfoSchema }),
    },
    async (args, { client, contacts }) => {
      const body = await client.purchaseInvoices({
        q: args.query,
        seller_id: args.seller_id,
        public_id: args.number,
        variable_symbol: args.variable_symbol,
        type: args.type,
        tax_payment_date_from: args.tax_date_from,
        tax_payment_date_till: args.tax_date_to,
        received_date_from: args.received_date_from,
        received_date_till: args.received_date_to,
        due_date_from: args.due_date_from,
        due_date_till: args.due_date_to,
        total_min: args.total_min,
        total_max: args.total_max,
        currency: args.currency,
        page: args.page,
        per_page: args.limit,
      });
      const raws = body.items ?? [];
      const names = await contacts.resolve(raws.map((r) => hrefId(r.seller)));
      return {
        data: {
          invoices: raws.map((raw) => purchaseRowOf(raw, names)),
          pagination: pageInfo(body, args.page, args.limit),
        },
      };
    },
  );

  registerReadTool(
    server,
    ctx,
    'get_purchase_invoice',
    {
      title: 'Get received invoice',
      description: 'One received (purchase) invoice with line items, VAT and payment symbols.',
      input: z.object({ invoice_id: z.string().describe('invoice_id from search_purchase_invoices') }),
      output: purchaseRow.extend(commonDetail),
    },
    async ({ invoice_id }, { client, contacts }) => {
      const raw = await client.purchaseInvoice(invoice_id);
      const names = await contacts.resolve([hrefId(raw.seller)]);
      return { data: { ...purchaseRowOf(raw, names), ...detailOf(raw) } };
    },
  );

  registerReadTool(
    server,
    ctx,
    'export_sales_invoice',
    {
      title: 'Export issued invoice (PDF / ISDOC)',
      description:
        'Downloads an issued (sales) invoice rendered by UOL and saves it on the machine running uol-mcp. ' +
        'format=isdoc also returns the ISDOC XML (Czech e-invoice standard), which is readable line by line. ' +
        'ISDOC exists only for issued (confirmed) invoices. Received invoices cannot be exported through the API.',
      input: z.object({
        invoice_id: z.string().describe('invoice_id from search_sales_invoices'),
        format: z.enum(['pdf', 'isdoc']).default('pdf'),
      }),
      output: savedFile.extend({ invoice_id: z.string(), format: z.enum(['pdf', 'isdoc']) }),
    },
    async ({ invoice_id, format }, { client, config }) => {
      const mediaType = format === 'pdf' ? 'application/pdf' : 'text/isdoc';
      let file;
      try {
        file = await client.exportSalesInvoice(invoice_id, mediaType);
      } catch (error) {
        if (error instanceof UolApiError && error.status === 422) {
          throw new UolApiError(
            `UOL cannot render this invoice as ${format.toUpperCase()} in its current state (only issued invoices can be exported to ISDOC). ${error.message}`,
            422,
            error.code,
          );
        }
        throw error;
      }
      // Content negotiation is the whole mechanism: JSON here means the format didn't apply.
      if (!file.contentType.toLowerCase().startsWith(mediaType)) {
        throw new UolApiError(`Expected ${mediaType} but UOL answered ${file.contentType}.`, 200, 'invalid_response');
      }
      const name = safeFileName(file.fileName, `faktura-${invoice_id}.${format}`);
      const { path, blocks } = await deliverFile(config, name, file.bytes, mediaType);
      const xml =
        format === 'isdoc'
          ? [{ type: 'text' as const, text: truncate(file.bytes.toString('utf8'), 100_000) }]
          : [];
      return {
        data: {
          invoice_id,
          format,
          file_path: path,
          file_name: name,
          content_type: file.contentType,
          size_bytes: file.bytes.length,
        },
        extra: [...blocks, ...xml],
      };
    },
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated, full file saved to disk]`;
}
