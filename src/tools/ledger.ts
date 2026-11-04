import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { fetchPages } from '../domain/paging.js';
import type { RawAccountingRecord, RawInternalDocument } from '../uol/client.js';
import { amount, hrefId, money, pageInfo, refId, str } from '../uol/normalize.js';
import { type ToolContext, registerReadTool } from './context.js';
import { isoDate, limitArg, pageArg, pageInfo as pageInfoSchema } from './schemas.js';

const posting = z.object({
  id: z.number().nullable(),
  date: z.string().nullable(),
  debit_account: z.string().nullable().describe('Má dáti'),
  credit_account: z.string().nullable().describe('Dal'),
  amount: z.number().nullable().describe('Home currency'),
  document_amount: z.number().nullable().describe('In the document currency'),
  currency: z.string().nullable().describe('Document currency'),
  description: z.string().nullable(),
  document_type: z.string().nullable().describe('UOL document series, e.g. FO = issued invoice, FP = received, ID = internal'),
  document_number: z.string().nullable(),
  contact_id: z.string().nullable(),
  department_id: z.string().nullable(),
  posted: z.boolean().describe('UOL status "valid" means posted for ledger rows'),
});

interface RawPostingExtras {
  contact?: { _meta?: { href?: string | null } | null } | null;
  department?: { department_id?: string | null } | null;
}

function postingRow(raw: RawAccountingRecord & RawPostingExtras): z.output<typeof posting> {
  return {
    id: raw.id ?? null,
    date: str(raw.date)?.slice(0, 10) ?? null,
    debit_account: refId(raw.debit_account, 'chart_of_account_id'),
    credit_account: refId(raw.credit_account, 'chart_of_account_id'),
    amount: amount(raw.accounting_amount) ?? amount(raw.amount),
    document_amount: amount(raw.amount),
    currency: refId(raw.currency, 'currency_id'),
    description: str(raw.description),
    document_type: refId(raw.doc_type, 'document_config_id'),
    document_number: str(raw.doc_number),
    contact_id: hrefId(raw.contact),
    department_id: refId(raw.department, 'department_id'),
    posted: raw.status?.toLowerCase() === 'valid',
  };
}

const internalDocument = z.object({
  number: z.string().nullable(),
  date: z.string().nullable(),
  note: z.string().nullable(),
  status: z.string().nullable().describe('confirmed = posted'),
  total: z.number().describe('Sum of the line amounts, home currency'),
  items: z.array(
    z.object({
      debit_account: z.string().nullable(),
      credit_account: z.string().nullable(),
      amount: z.number().nullable(),
      description: z.string().nullable(),
    }),
  ),
  items_truncated: z.boolean(),
});

const MAX_ITEMS = 20;

function internalRow(raw: RawInternalDocument): z.output<typeof internalDocument> {
  const items = (raw.items ?? []).map((i) => ({
    debit_account: str(i.debit_account_id),
    credit_account: str(i.credit_account_id),
    amount: amount(i.accounting_amount) ?? amount(i.amount),
    description: str(i.description),
  }));
  return {
    number: str(raw.number),
    date: str(raw.date),
    note: str(raw.note),
    status: str(raw.status),
    total: money(items.reduce((s, i) => s + (i.amount ?? 0), 0)),
    items: items.slice(0, MAX_ITEMS),
    items_truncated: items.length > MAX_ITEMS,
  };
}

export function registerLedgerTools(server: McpServer, ctx: ToolContext): void {
  registerReadTool(
    server,
    ctx,
    'search_accounting_records',
    {
      title: 'Search the general ledger',
      description:
        'General-ledger postings (účetní deník): date, debit / credit account, amount in the home currency, source document. ' +
        'Account filters match by prefix: debit_account=5 → every expense account, credit_account=602 → service revenue. ' +
        'For monthly revenue / expense totals use get_financial_overview instead.',
      input: z.object({
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        debit_account: z.string().regex(/^\d+$/).optional().describe('Account or prefix on the debit side'),
        credit_account: z.string().regex(/^\d+$/).optional().describe('Account or prefix on the credit side'),
        query: z.string().optional().describe('Full-text over the posting'),
        document_number: z.string().optional().describe('Number of the linked document'),
        page: pageArg,
        limit: limitArg(250, 50),
      }),
      output: z.object({ postings: z.array(posting), pagination: pageInfoSchema }),
    },
    async (args, { client }) => {
      const body = await client.accountingRecords({
        date_from: args.date_from,
        date_till: args.date_to,
        debit_account: args.debit_account,
        credit_account: args.credit_account,
        q: args.query,
        linked_doc_number: args.document_number,
        page: args.page,
        per_page: args.limit,
      });
      return {
        data: {
          postings: (body.items ?? []).map((r) => postingRow(r as RawAccountingRecord & RawPostingExtras)),
          pagination: pageInfo(body, args.page, args.limit),
        },
      };
    },
  );

  registerReadTool(
    server,
    ctx,
    'list_internal_documents',
    {
      title: 'List internal documents',
      description:
        'Internal accounting documents (interní doklady): payroll, travel, opening balances, VAT closing ("DPH …") and manual entries, newest first. ' +
        'UOL has no date filter for these, so the server reads them all (bounded) and filters by date and note text.',
      input: z.object({
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        note: z.string().optional().describe('Case-insensitive substring of the note, e.g. "DPH" or "cestovné"'),
        limit: limitArg(100, 25),
      }),
      output: z.object({
        documents: z.array(internalDocument),
        match_count: z.number(),
        truncated: z.boolean().describe('True when UOL had more documents than one call reads'),
      }),
    },
    async (args, { client }) => {
      const { rows, truncated } = await fetchPages(
        (page, perPage) => client.internalDocuments({ page, per_page: perPage }),
        20,
      );
      const needle = args.note?.toLowerCase();
      const matches = rows
        .filter((d) => {
          const date = str(d.date) ?? '';
          if (args.date_from && date < args.date_from) return false;
          if (args.date_to && date > args.date_to) return false;
          return !needle || (d.note ?? '').toLowerCase().includes(needle);
        })
        .sort((a, b) => (str(b.date) ?? '').localeCompare(str(a.date) ?? ''));
      return {
        data: { documents: matches.slice(0, args.limit).map(internalRow), match_count: matches.length, truncated },
      };
    },
  );
}
