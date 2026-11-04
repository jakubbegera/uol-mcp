import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { amount, pageInfo, refId, str } from '../uol/normalize.js';
import { type ToolContext, registerReadTool } from './context.js';
import { limitArg, pageArg, pageInfo as pageInfoSchema } from './schemas.js';

type Raw = Record<string, any>;

const movementItem = z.object({
  date: z.string().nullable(),
  amount: z.number().nullable(),
  variable_symbol: z.string().nullable(),
  note: z.string().nullable(),
  contact_id: z.string().nullable(),
  payment_rule_id: z.string().nullable(),
  linked_document: z.string().nullable().describe('Document number this part was paired with (e.g. an invoice)'),
  confirmed: z.boolean().nullable(),
});

const movement = z.object({
  bank_movement_id: z.string().nullable(),
  bank_account_id: z.string().nullable(),
  date: z.string().nullable().describe('Date of the first part'),
  amount: z.number().nullable().describe('Positive = incoming, negative = outgoing'),
  variable_symbol: z.string().nullable(),
  iban: z.string().nullable().describe('Counterparty account'),
  note: z.string().nullable(),
  items: z.array(movementItem),
});

function movementRow(raw: Raw): z.output<typeof movement> {
  const items = ((raw.items ?? []) as Raw[]).map((i) => ({
    date: str(i.date),
    amount: amount(i.amount),
    variable_symbol: str(i.variable_symbol),
    note: str(i.note),
    contact_id: refId(i.contact, 'contact_id'),
    payment_rule_id: refId(i.payment_rule, 'payment_rule_id'),
    linked_document: refId(i.linked_doc, 'linked_doc_number'),
    confirmed: typeof i.confirmed === 'boolean' ? i.confirmed : null,
  }));
  return {
    bank_movement_id: str(raw.bank_movement_id),
    bank_account_id: refId(raw.bank_account, 'bank_account_id'),
    date: items[0]?.date ?? null,
    amount: amount(raw.amount),
    variable_symbol: str(raw.variable_symbol),
    iban: str(raw.iban),
    note: str(raw.note),
    items,
  };
}

const cashDocument = z.object({
  number: z.string().nullable(),
  issue_date: z.string().nullable(),
  petty_cash_id: z.string().nullable(),
  total: z.number().nullable(),
  note: z.string().nullable(),
  contact_id: z.string().nullable(),
  confirmed: z.boolean().nullable(),
  vat_document: z.boolean().nullable(),
  gid: z.number().nullable().describe('Internal id, used by pair_uploaded_document'),
  lines: z.array(z.object({ description: z.string().nullable(), price: z.number().nullable() })),
});

function cashRow(raw: Raw): z.output<typeof cashDocument> {
  return {
    number: str(raw.number),
    issue_date: str(raw.issue_date),
    petty_cash_id: refId(raw.petty_cash, 'petty_cash_id'),
    total: amount(raw.total),
    note: str(raw.note),
    contact_id: refId(raw.contact, 'contact_id'),
    confirmed: typeof raw.confirmed === 'boolean' ? raw.confirmed : null,
    vat_document: typeof raw.vat_document === 'boolean' ? raw.vat_document : null,
    gid: typeof raw.gid === 'number' ? raw.gid : null,
    lines: ((raw.items ?? []) as Raw[]).map((i) => ({
      description: str(i.description),
      price: amount(i.price ?? i.total_price),
    })),
  };
}

export function registerBankingTools(server: McpServer, ctx: ToolContext): void {
  registerReadTool(
    server,
    ctx,
    'list_bank_movements',
    {
      title: 'List bank movements',
      description:
        'Bank statement lines imported into UOL (bankovní pohyby), as UOL lists them, with the parts each movement was split into ' +
        'and the documents they were paired with. UOL offers no date filter here; page through. ' +
        'For balances use get_bank_balances.',
      input: z.object({ page: pageArg, limit: limitArg(250, 50) }),
      output: z.object({ movements: z.array(movement), pagination: pageInfoSchema }),
    },
    async ({ page, limit }, { client }) => {
      const body = await client.list('/v1/bank_movements', { page, per_page: limit });
      return { data: { movements: (body.items ?? []).map(movementRow), pagination: pageInfo(body, page, limit) } };
    },
  );

  registerReadTool(
    server,
    ctx,
    'list_cash_documents',
    {
      title: 'List petty-cash documents',
      description:
        'Petty-cash receipts (příjmové pokladní doklady, kind=income) or disbursements (výdajové, kind=disbursement). ' +
        'Cash registers themselves are in list_codebook kind=petty_cashes.',
      input: z.object({
        kind: z.enum(['income', 'disbursement']),
        page: pageArg,
        limit: limitArg(250, 50),
      }),
      output: z.object({ kind: z.string(), documents: z.array(cashDocument), pagination: pageInfoSchema }),
    },
    async ({ kind, page, limit }, { client }) => {
      // UOL spells the endpoint "disburstments".
      const path = kind === 'income' ? '/v1/petty_cash_incomes' : '/v1/petty_cash_disburstments';
      const body = await client.list(path, { page, per_page: limit });
      return { data: { kind, documents: (body.items ?? []).map(cashRow), pagination: pageInfo(body, page, limit) } };
    },
  );
}
