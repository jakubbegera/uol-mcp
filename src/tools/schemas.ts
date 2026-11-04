import { z } from 'zod';

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .describe('Date as YYYY-MM-DD');

export const pageArg = z.number().int().min(1).default(1).describe('Page number, starting at 1');

export const limitArg = (max = 100, fallback = 25) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Rows per page (max ${max})`);

export const pageInfo = z.object({
  page: z.number(),
  per_page: z.number(),
  has_more: z.boolean(),
  total_pages: z.number().nullable(),
});

export const party = z.object({
  id: z.string().nullable().describe('UOL contact id (slug), usable with get_contact'),
  name: z.string().nullable().describe('Resolved contact name; null when not looked up'),
});

export const invoiceStatus = z
  .enum(['draft', 'issued', 'cancelled', 'unknown'])
  .describe('draft = koncept (UOL "valid"), issued = vystavená ("confirmed"), cancelled = storno ("invalid")');

export const invoiceType = z.enum(['standard', 'corrective', 'proforma', 'penalty']);

export const invoiceItem = z.object({
  item_id: z.number().nullable().describe('Line id, for update_sales_invoice remove_item_ids'),
  description: z.string().nullable(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable().describe('Without VAT'),
  unit_price_with_vat: z.number().nullable(),
  vat_rate: z.number().nullable().describe('Percent'),
  discount_percent: z.number().nullable(),
  product_id: z.string().nullable(),
});

export const savedFile = z.object({
  file_path: z
    .string()
    .nullable()
    .describe('Absolute path of the saved file on the machine running uol-mcp; null when the file is embedded in the result (HTTP transport)'),
  file_name: z.string(),
  content_type: z.string(),
  size_bytes: z.number(),
});
