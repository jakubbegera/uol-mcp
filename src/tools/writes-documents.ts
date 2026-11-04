import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { InputError } from '../domain/uploads.js';
import { stripNoise, str } from '../uol/normalize.js';
import { type ToolContext, type UolSession, registerTool } from './context.js';
import { isoDate } from './schemas.js';
import { CONFIRM_FIRST, DESTRUCTIVE, WRITE, auditedWrite } from './write-support.js';

/** Document kinds an uploaded document can be paired with, as UOL names them. */
const PAIRABLE = ['purchase_invoice', 'sales_invoice', 'petty_cash_disburstment', 'petty_cash_income'] as const;

const TAG_TYPES = [
  'annual_tax_settlement_request', 'assessment', 'attendance_records', 'bank_statement', 'birth_certificate',
  'contract', 'court_ruling', 'customs_documents', 'delivery_note', 'demands_for_payment',
  'employee_leaving_work_details', 'employee_registration_form', 'employment_contract_addendum',
  'employment_contract', 'employment_termination_letter', 'execution_employee_warrant', 'foreclosure_notice',
  'generic', 'income_proof', 'marriage_certificate', 'maternity_announcement', 'order',
  'overview_of_income_and_expenses', 'payroll_summary_statement', 'pension_insurance_record',
  'petty_cash_disburstment', 'petty_cash_income', 'power_of_attorney', 'purchase_invoice',
  'prescription_of_advances', 'receipt', 'salary_agreement', 'salary_certificate_request',
  'salary_change_request', 'sales_invoice', 'sales_summary_statement', 'set_off_agreement', 'sick_leave_letter',
  'spot_trade', 'tax_credit_request', 'transactions_summary', 'travelling_expenses_claim', 'vacation_request',
] as const;

/**
 * Pairings point at a document's internal `gid`, which users never see.
 * Invoices are resolved from their invoice_id; petty-cash documents need the
 * gid itself (list_cash_documents returns it).
 */
async function resolveGid(
  { client }: UolSession,
  type: (typeof PAIRABLE)[number],
  invoiceId: string | undefined,
  gid: number | undefined,
): Promise<number> {
  if (gid !== undefined) return gid;
  if (!invoiceId) throw new InputError('Give target_invoice_id (invoices) or target_gid (petty-cash documents).');
  if (type === 'purchase_invoice') return requireGid(await client.purchaseInvoice(invoiceId), invoiceId);
  if (type === 'sales_invoice') return requireGid(await client.salesInvoice(invoiceId), invoiceId);
  throw new InputError('Petty-cash documents are paired by target_gid (from list_cash_documents).');
}

function requireGid(raw: { gid?: number }, invoiceId: string): number {
  if (typeof raw.gid !== 'number') throw new InputError(`UOL returned no internal id (gid) for invoice ${invoiceId}.`);
  return raw.gid;
}

export function registerDocumentWriteTools(server: McpServer, ctx: ToolContext): void {
  registerTool(
    server,
    ctx,
    'mark_document_processed',
    {
      title: 'Mark an uploaded document processed',
      description: `Sets an uploaded document's state to processed (zpracováno) — the accountant's inbox step. ${CONFIRM_FIRST}`,
      input: z.object({ document_id: z.string(), dry_run: z.boolean().default(false) }),
      output: z.object({ dry_run: z.boolean(), document_id: z.string(), state: z.string().nullable() }),
    },
    { ...WRITE, idempotentHint: true },
    async ({ document_id, dry_run }, session) => {
      const current = await session.client.uploadedDocumentWithPairings(document_id);
      if (dry_run || current.state === 'processed') {
        return { data: { dry_run, document_id, state: str(current.state) } };
      }
      const updated = await auditedWrite(
        session,
        ctx,
        { tool: 'mark_document_processed', method: 'PATCH', path: `/v1/uploaded_documents/${document_id}`, payload: { state: 'processed' } },
        () => session.client.setUploadedDocumentState(document_id, 'processed'),
        () => document_id,
      );
      return { data: { dry_run: false, document_id, state: str(updated.state) ?? 'processed' } };
    },
  );

  registerTool(
    server,
    ctx,
    'pair_uploaded_document',
    {
      title: 'Pair an uploaded document with a bookkeeping record',
      description:
        'Links an uploaded document (e.g. the PDF of a received invoice) to the record booked from it. ' +
        `Invoices are given by invoice_id; petty-cash documents by gid. ${CONFIRM_FIRST}`,
      input: z.object({
        document_id: z.string(),
        target_type: z.enum(PAIRABLE),
        target_invoice_id: z.string().optional().describe('invoice_id for purchase_invoice / sales_invoice'),
        target_gid: z.number().int().optional().describe('Internal gid, e.g. from list_cash_documents'),
        dry_run: z.boolean().default(false),
      }),
      output: z.object({
        dry_run: z.boolean(),
        payload: z.record(z.string(), z.unknown()),
        pairings: z.array(z.object({ type: z.string().nullable(), gid: z.number().nullable() })),
      }),
    },
    WRITE,
    async (args, session) => {
      const gid = await resolveGid(session, args.target_type, args.target_invoice_id, args.target_gid);
      const payload = { document_pairable_type: args.target_type, document_pairable_id: String(gid) };
      const pairingsOf = (doc: { document_pairings?: { document_pairable_type?: string; document_pairable_id?: number }[] }) =>
        (doc.document_pairings ?? []).map((p) => ({ type: str(p.document_pairable_type), gid: p.document_pairable_id ?? null }));
      if (args.dry_run) {
        const current = await session.client.uploadedDocumentWithPairings(args.document_id);
        return { data: { dry_run: true, payload, pairings: pairingsOf(current) } };
      }
      await auditedWrite(
        session,
        ctx,
        { tool: 'pair_uploaded_document', method: 'POST', path: `/v1/uploaded_documents/${args.document_id}/pairings`, payload },
        () => session.client.pairUploadedDocument(args.document_id, payload),
        () => args.document_id,
      );
      // The POST answer doesn't list the new pairing (seen on DEMO); read it back.
      const doc = await session.client.uploadedDocumentWithPairings(args.document_id);
      return { data: { dry_run: false, payload, pairings: pairingsOf(doc) } };
    },
  );

  registerTool(
    server,
    ctx,
    'tag_uploaded_document',
    {
      title: 'Tag an uploaded document',
      description:
        'Adds a tag describing what an uploaded document is (receipt, contract, bank statement, …), optionally with its own number and date. ' +
        `Needs the tag permission in UOL. ${CONFIRM_FIRST}`,
      input: z.object({
        document_id: z.string(),
        tag_type: z.enum(TAG_TYPES),
        title: z.string().optional(),
        number: z.string().optional().describe('The issuer\'s own number, e.g. "6/2026" for a bank statement'),
        date: isoDate.optional(),
        dry_run: z.boolean().default(false),
      }),
      output: z.object({ dry_run: z.boolean(), payload: z.record(z.string(), z.unknown()), tag: z.record(z.string(), z.unknown()).nullable() }),
    },
    WRITE,
    async (args, session) => {
      const payload = Object.fromEntries(
        Object.entries({ tag_type: args.tag_type, title: args.title, number: args.number, date: args.date }).filter(
          ([, v]) => v !== undefined,
        ),
      );
      if (args.dry_run) return { data: { dry_run: true, payload, tag: null } };
      const tag = await auditedWrite(
        session,
        ctx,
        { tool: 'tag_uploaded_document', method: 'POST', path: `/v1/uploaded_documents/${args.document_id}/tags`, payload },
        () => session.client.tagUploadedDocument(args.document_id, payload),
        (t) => str(t.id),
      );
      return { data: { dry_run: false, payload, tag: stripNoise(tag) } };
    },
  );

  registerTool(
    server,
    ctx,
    'untag_uploaded_document',
    {
      title: 'Remove a tag from an uploaded document',
      description: `Removes one tag (id from get_uploaded_document) from an uploaded document. ${CONFIRM_FIRST}`,
      input: z.object({ document_id: z.string(), tag_id: z.string(), dry_run: z.boolean().default(false) }),
      output: z.object({ dry_run: z.boolean(), document_id: z.string(), removed_tag_id: z.string().nullable() }),
    },
    DESTRUCTIVE,
    async ({ document_id, tag_id, dry_run }, session) => {
      if (dry_run) return { data: { dry_run: true, document_id, removed_tag_id: null } };
      await auditedWrite(
        session,
        ctx,
        { tool: 'untag_uploaded_document', method: 'DELETE', path: `/v1/uploaded_documents/${document_id}/tags/${tag_id}`, payload: null },
        () => session.client.untagUploadedDocument(document_id, tag_id),
        () => tag_id,
      );
      return { data: { dry_run: false, document_id, removed_tag_id: tag_id } };
    },
  );
}
