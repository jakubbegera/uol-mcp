import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { InputError } from '../domain/uploads.js';
import { invoiceStatus, stripNoise, str } from '../uol/normalize.js';
import { type ToolContext, registerFullTool } from './context.js';
import { isoDate } from './schemas.js';
import { CONFIRM_FIRST, DESTRUCTIVE, auditedWrite } from './write-support.js';

/*
 * UOL_ACCESS=full only. These change or remove records in ways that are hard
 * to undo; each checks the current state first and supports dry_run.
 */

const API_PATH = /^\/?v1\/[a-z0-9_/{}.-]*$/i;

export function registerDestructiveTools(server: McpServer, ctx: ToolContext): void {
  registerFullTool(
    server,
    ctx,
    'delete_sales_invoice',
    {
      title: 'Delete a draft invoice',
      description:
        'Permanently deletes a DRAFT sales invoice. Issued invoices cannot be deleted — cancel them with repair_sales_invoice (storno). ' +
        CONFIRM_FIRST,
      input: z.object({ invoice_id: z.string(), dry_run: z.boolean().default(false) }),
      output: z.object({ dry_run: z.boolean(), invoice_id: z.string(), number: z.string().nullable(), deleted: z.boolean() }),
    },
    DESTRUCTIVE,
    async ({ invoice_id, dry_run }, session) => {
      const current = await session.client.salesInvoice(invoice_id);
      const status = invoiceStatus(current.status);
      if (status !== 'draft') {
        throw new InputError(
          `Invoice ${str(current.public_id) ?? invoice_id} is ${status}; only drafts can be deleted. Use repair_sales_invoice to cancel an issued one.`,
        );
      }
      const number = str(current.public_id);
      if (dry_run) return { data: { dry_run: true, invoice_id, number, deleted: false } };
      await auditedWrite(
        session,
        ctx,
        { tool: 'delete_sales_invoice', method: 'DELETE', path: `/v1/sales_invoices/${invoice_id}`, payload: null },
        () => session.client.deleteSalesInvoice(invoice_id),
        () => invoice_id,
      );
      return { data: { dry_run: false, invoice_id, number, deleted: true } };
    },
  );

  registerFullTool(
    server,
    ctx,
    'repair_sales_invoice',
    {
      title: 'Cancel or disconfirm an issued invoice',
      description:
        'For an ISSUED sales invoice: method=cancel books a storno (the invoice stays, cancelled); method=disconfirm turns it back into a draft — ' +
        'its accounting and VAT entries are removed — so update_sales_invoice can change it and issue it again. ' +
        'UOL refuses invoices with payments bound to them or in a locked period, and needs the cancel right on the user. ' +
        CONFIRM_FIRST,
      input: z.object({
        invoice_id: z.string(),
        method: z.enum(['cancel', 'disconfirm']),
        reason: z.string().optional().describe('Shown in UOL; "Storno by user" when empty'),
        date: isoDate.optional().describe('Date of the repair'),
        dry_run: z.boolean().default(false),
      }),
      output: z.object({
        dry_run: z.boolean(),
        payload: z.record(z.string(), z.unknown()),
        result: z.record(z.string(), z.unknown()).nullable(),
      }),
    },
    DESTRUCTIVE,
    async (args, session) => {
      const current = await session.client.salesInvoice(args.invoice_id);
      if (invoiceStatus(current.status) !== 'issued') {
        throw new InputError(`Invoice ${str(current.public_id) ?? args.invoice_id} is not issued; only issued invoices can be repaired.`);
      }
      const payload = Object.fromEntries(
        Object.entries({
          document_type: 'FO',
          document_id: args.invoice_id,
          method: args.method,
          reason: args.reason,
          date: args.date,
        }).filter(([, v]) => v !== undefined),
      );
      if (args.dry_run) return { data: { dry_run: true, payload, result: null } };
      const result = await auditedWrite(
        session,
        ctx,
        { tool: 'repair_sales_invoice', method: 'POST', path: '/v1/repairs', payload },
        () => session.client.repairDocument(payload),
        () => args.invoice_id,
      );
      return { data: { dry_run: false, payload, result: stripNoise(result ?? {}) } };
    },
  );

  registerFullTool(
    server,
    ctx,
    'api_request',
    {
      title: 'Raw UOL write',
      description:
        'Sends a POST / PATCH / PUT / DELETE to any UOL REST path (spec: https://api.uol.cz/openapi.yaml) for writes no other tool covers — ' +
        'bank movements, petty-cash documents, internal documents, products, contracts. Booleans are sent as strings, as UOL requires. ' +
        `Prefer the dedicated tools. dry_run shows the request without sending it. ${CONFIRM_FIRST}`,
      input: z.object({
        method: z.enum(['POST', 'PATCH', 'PUT', 'DELETE']),
        path: z.string().describe('Path under the API root starting with /v1/'),
        body: z.record(z.string(), z.unknown()).optional(),
        dry_run: z.boolean().default(false),
      }),
      output: z.object({
        dry_run: z.boolean(),
        method: z.string(),
        path: z.string(),
        body: z.record(z.string(), z.unknown()).nullable(),
        response: z.unknown(),
      }),
    },
    DESTRUCTIVE,
    async (args, session) => {
      if (!API_PATH.test(args.path) || args.path.includes('..')) {
        throw new InputError('path must be a relative API path starting with /v1/ (no scheme, host or "..")');
      }
      const path = args.path.startsWith('/') ? args.path : `/${args.path}`;
      const base = { method: args.method, path, body: args.body ?? null };
      if (args.dry_run) return { data: { dry_run: true, ...base, response: null } };
      const response = await auditedWrite(
        session,
        ctx,
        { tool: 'api_request', method: args.method, path, payload: args.body ?? null },
        () => session.client.http.request(args.method, path, args.body),
        () => null,
      );
      return { data: { dry_run: false, ...base, response } };
    },
  );
}
