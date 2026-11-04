import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { amount, pageInfo, refId, stripNoise, str } from '../uol/normalize.js';
import { type ToolContext, registerReadTool } from './context.js';
import { isoDate, limitArg, pageArg, pageInfo as pageInfoSchema } from './schemas.js';

type Raw = Record<string, any>;

const product = z.object({
  product_id: z.string().nullable().describe('Usable as product_id on invoice lines'),
  name: z.string().nullable(),
  category_id: z.string().nullable(),
  unit_id: z.string().nullable(),
  vat_code: z.string().nullable(),
  barcode: z.string().nullable(),
  purchase_price: z.number().nullable(),
  hidden: z.boolean().nullable(),
});

function productRow(raw: Raw): z.output<typeof product> {
  return {
    product_id: str(raw.product_id),
    name: str(raw.name),
    category_id: str(raw.category_id),
    unit_id: str(raw.unit_id),
    vat_code: str(raw.vat_code),
    barcode: str(raw.barcode),
    purchase_price: amount(raw.purchase_price),
    hidden: typeof raw.hidden === 'boolean' ? raw.hidden : null,
  };
}

const stock = z.object({
  product_id: z.string().nullable(),
  department_id: z.string().nullable().describe('Warehouse / department'),
  quantity: z.number().nullable(),
  total_price: z.number().nullable().describe('Stock value'),
  batch: z.string().nullable(),
  expiration: z.string().nullable(),
});

const order = z.object({
  order_id: z.string().nullable(),
  status: z.string().nullable(),
  contact_id: z.string().nullable(),
  received_date: z.string().nullable(),
  fulfilled_on: z.string().nullable(),
  valid_till: z.string().nullable(),
  currency: z.string().nullable(),
  text: z.string().nullable(),
  note: z.string().nullable(),
  items: z.array(
    z.object({
      product_id: z.string().nullable(),
      description: z.string().nullable(),
      quantity: z.number().nullable(),
      unit_price: z.number().nullable(),
      total_price: z.number().nullable(),
    }),
  ),
});

function orderRow(raw: Raw): z.output<typeof order> {
  return {
    order_id: str(raw.order_id),
    status: str(raw.status),
    contact_id: refId(raw.contact, 'contact_id'),
    received_date: str(raw.date_of_receipt),
    fulfilled_on: str(raw.fullfilled_on),
    valid_till: str(raw.valid_till),
    currency: refId(raw.currency, 'currency_id'),
    text: str(raw.text),
    note: str(raw.note),
    items: ((raw.items ?? []) as Raw[]).map((i) => ({
      product_id: refId(i.product, 'product_id'),
      description: str(i.description),
      quantity: amount(i.quantity),
      unit_price: amount(i.unit_price),
      total_price: amount(i.total_price),
    })),
  };
}

export function registerWarehouseTools(server: McpServer, ctx: ToolContext): void {
  registerReadTool(
    server,
    ctx,
    'search_products',
    {
      title: 'Search products',
      description: 'Products and services in the price list (ceník / sklad) by name, code or barcode.',
      input: z.object({
        query: z.string().optional(),
        barcode: z.string().optional(),
        include_hidden: z.boolean().default(false),
        page: pageArg,
        limit: limitArg(),
      }),
      output: z.object({ products: z.array(product), pagination: pageInfoSchema }),
    },
    async (args, { client }) => {
      const body = await client.list('/v1/products', {
        q: args.query,
        barcode: args.barcode,
        hidden: args.include_hidden ? 'all' : 'no',
        page: args.page,
        per_page: args.limit,
      });
      return { data: { products: (body.items ?? []).map(productRow), pagination: pageInfo(body, args.page, args.limit) } };
    },
  );

  registerReadTool(
    server,
    ctx,
    'get_product',
    {
      title: 'Get product',
      description: 'One product with every field UOL stores (prices, VAT and accounting settings), minus audit fields.',
      input: z.object({ product_id: z.string() }),
      output: z.object({ product: z.record(z.string(), z.unknown()) }),
    },
    async ({ product_id }, { client }) => ({
      data: { product: stripNoise((await client.get(`/v1/products/${encodeURIComponent(product_id)}`)) as Raw) },
    }),
  );

  registerReadTool(
    server,
    ctx,
    'get_stock_levels',
    {
      title: 'Stock levels',
      description: 'Warehouse stock per product and department (skladové zásoby): quantity, value, batch and expiry.',
      input: z.object({
        product_id: z.string().optional(),
        department_id: z.string().optional(),
        quantity_more_than: z.number().optional(),
        quantity_less_than: z.number().optional().describe('E.g. 1 to find what is out of stock'),
        expiration_from: isoDate.optional(),
        expiration_to: isoDate.optional(),
        page: pageArg,
        limit: limitArg(250, 50),
      }),
      output: z.object({ stock: z.array(stock), pagination: pageInfoSchema }),
    },
    async (args, { client }) => {
      const body = await client.list('/v1/warehouse/statuses', {
        product_id: args.product_id,
        department_id: args.department_id,
        quantity_more_than: args.quantity_more_than,
        quantity_less_than: args.quantity_less_than,
        expiration_from: args.expiration_from,
        expiration_to: args.expiration_to,
        page: args.page,
        per_page: args.limit,
      });
      return {
        data: {
          stock: (body.items ?? []).map((raw: Raw) => ({
            product_id: refId(raw.product, 'product_id'),
            department_id: refId(raw.department, 'department_id'),
            quantity: amount(raw.quantity),
            total_price: amount(raw.total_price),
            batch: str(raw.batch),
            expiration: str(raw.expiration),
          })),
          pagination: pageInfo(body, args.page, args.limit),
        },
      };
    },
  );

  registerReadTool(
    server,
    ctx,
    'list_orders',
    {
      title: 'List orders',
      description:
        'Received orders from customers (kind=sales, přijaté objednávky) or orders sent to suppliers (kind=purchase, vydané objednávky). ' +
        'Filters other than paging apply to sales orders only.',
      input: z.object({
        kind: z.enum(['sales', 'purchase']),
        query: z.string().optional(),
        contact_id: z.string().optional(),
        status: z.string().optional(),
        created_from: isoDate.optional(),
        created_to: isoDate.optional(),
        fulfilled_from: isoDate.optional(),
        fulfilled_to: isoDate.optional(),
        page: pageArg,
        limit: limitArg(),
      }),
      output: z.object({ kind: z.string(), orders: z.array(order), pagination: pageInfoSchema }),
    },
    async (args, { client }) => {
      const sales = args.kind === 'sales';
      const body = await client.list(sales ? '/v1/sales_orders' : '/v1/purchase_orders', {
        ...(sales
          ? {
              q: args.query,
              contact_id: args.contact_id,
              status: args.status,
              created_at_from: args.created_from,
              created_at_until: args.created_to,
              fullfilled_on_from: args.fulfilled_from,
              fullfilled_on_until: args.fulfilled_to,
            }
          : {}),
        page: args.page,
        per_page: args.limit,
      });
      return {
        data: { kind: args.kind, orders: (body.items ?? []).map(orderRow), pagination: pageInfo(body, args.page, args.limit) },
      };
    },
  );
}
