import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { fetchAllReceivables, outstanding } from '../domain/receivables.js';
import type { RawReceivable } from '../uol/client.js';
import { amount, daysBetween, money, pragueDate, receivableKind, str } from '../uol/normalize.js';
import { type ToolContext, registerReadTool } from './context.js';
import { isoDate, limitArg, party } from './schemas.js';

const row = z.object({
  invoice_id: z.string().describe('Usable with get_sales_invoice'),
  number: z.string().nullable(),
  kind: z
    .enum(['standard', 'proforma', 'corrective', 'unknown'])
    .describe('corrective = credit note (dobropis), negative amounts'),
  customer: party,
  currency: z.string().nullable(),
  issue_date: z.string().nullable(),
  due_date: z.string().nullable(),
  total: z.number().nullable(),
  paid: z.number().nullable(),
  outstanding: z.number(),
  days_overdue: z.number().describe('0 when not yet due or nothing is outstanding'),
  last_payment_date: z.string().nullable(),
});

const currencyTotals = z.object({
  currency: z.string(),
  count: z.number(),
  total: z.number(),
  paid: z.number(),
  outstanding: z.number(),
  overdue_count: z.number(),
  overdue_outstanding: z.number(),
});

type Row = z.output<typeof row>;
type Totals = z.output<typeof currencyTotals>;

const SORTS = {
  days_overdue: (a: Row, b: Row) => b.days_overdue - a.days_overdue || b.outstanding - a.outstanding,
  outstanding: (a: Row, b: Row) => b.outstanding - a.outstanding,
  due_date: (a: Row, b: Row) => (a.due_date ?? '').localeCompare(b.due_date ?? ''),
  issue_date: (a: Row, b: Row) => (b.issue_date ?? '').localeCompare(a.issue_date ?? ''),
};

export function registerReceivableTools(server: McpServer, ctx: ToolContext): void {
  registerReadTool(
    server,
    ctx,
    'list_receivables',
    {
      title: 'Receivables (who owes us)',
      description:
        'Receivables of issued (sales) invoices — pohledávky: totals per currency plus the matching invoices, most overdue first by default. ' +
        'Answers "who owes me money", "what is overdue", "has customer X paid". ' +
        'Covers sales invoices only: the UOL API exposes no payment status for received (purchase) invoices.',
      input: z.object({
        state: z.enum(['unpaid', 'paid', 'all']).default('unpaid'),
        overdue_only: z.boolean().default(false).describe('Only unpaid invoices past their due date'),
        customer_id: z.string().optional().describe('Contact id from search_contacts'),
        issue_date_from: isoDate.optional(),
        issue_date_to: isoDate.optional(),
        due_date_from: isoDate.optional(),
        due_date_to: isoDate.optional(),
        sort: z.enum(['days_overdue', 'outstanding', 'due_date', 'issue_date']).default('days_overdue'),
        limit: limitArg(100, 25).describe('Invoices to list; totals always cover every match'),
      }),
      output: z.object({
        as_of: z.string().describe('Today in Europe/Prague; overdue is computed against this date'),
        match_count: z.number(),
        totals: z.array(currencyTotals),
        invoices: z.array(row),
        truncated: z.boolean().describe('True when UOL had more rows than one call reads; narrow the filters'),
      }),
    },
    async (args, { client, contacts }) => {
      const today = pragueDate(ctx.now());
      const { rows: raws, truncated } = await fetchAllReceivables(client, {
        state: args.overdue_only ? 'unpaid' : args.state,
        contact_id: args.customer_id,
        invoice_issue_date_from: args.issue_date_from,
        invoice_issue_date_to: args.issue_date_to,
        due_date_from: args.due_date_from,
        due_date_to: args.due_date_to,
      });

      const rows = raws
        .filter((raw) => !raw.cancelled)
        .map((raw) => toRow(raw, today))
        .filter((r) => !args.overdue_only || r.days_overdue > 0);

      const listed = [...rows].sort(SORTS[args.sort]).slice(0, args.limit);
      const names = await contacts.resolve(listed.map((r) => r.customer.id));
      for (const r of listed) r.customer.name = r.customer.id ? (names.get(r.customer.id) ?? null) : null;

      return {
        data: { as_of: today, match_count: rows.length, totals: totalsOf(rows), invoices: listed, truncated },
      };
    },
  );
}

function toRow(raw: RawReceivable, today: string): Row {
  const due = outstanding(raw);
  const dueDate = str(raw.due_date);
  const late = dueDate && due > 0 ? daysBetween(dueDate, today) : 0;
  return {
    invoice_id: String(raw.invoice_id ?? ''),
    number: str(raw.invoice_public_id),
    kind: receivableKind(raw.invoice_type),
    customer: { id: str(raw.contact_id), name: null },
    currency: str(raw.currency_id),
    issue_date: str(raw.issue_date),
    due_date: dueDate,
    total: amount(raw.total_amount),
    paid: amount(raw.paid_amount),
    outstanding: due,
    days_overdue: Math.max(0, late),
    last_payment_date: str(raw.last_payment_date),
  };
}

function totalsOf(rows: Row[]): Totals[] {
  const byCurrency = new Map<string, Totals>();
  for (const r of rows) {
    const currency = r.currency ?? 'CZK';
    const t = byCurrency.get(currency) ?? {
      currency,
      count: 0,
      total: 0,
      paid: 0,
      outstanding: 0,
      overdue_count: 0,
      overdue_outstanding: 0,
    };
    t.count += 1;
    t.total = money(t.total + (r.total ?? 0));
    t.paid = money(t.paid + (r.paid ?? 0));
    t.outstanding = money(t.outstanding + r.outstanding);
    if (r.days_overdue > 0) {
      t.overdue_count += 1;
      t.overdue_outstanding = money(t.overdue_outstanding + r.outstanding);
    }
    byCurrency.set(currency, t);
  }
  return [...byCurrency.values()].sort((a, b) => b.outstanding - a.outstanding);
}
