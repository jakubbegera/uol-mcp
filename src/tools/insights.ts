import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { balancesByCurrency, latestBalances } from '../domain/bank.js';
import { currentRevision } from '../domain/company.js';
import { type LedgerSummary, ledgerSummary, monthKeys } from '../domain/ledger.js';
import { fetchPages } from '../domain/paging.js';
import { fetchAllReceivables, receivableRow, receivableTotals } from '../domain/receivables.js';
import { type VatKind, vatOverview } from '../domain/vat.js';
import type { UolClient } from '../uol/client.js';
import { money, pageInfo, pragueDate, str, vatPeriod } from '../uol/normalize.js';
import { type ToolContext, describeError, registerReadTool } from './context.js';
import { receivableRowSchema, receivableTotalsSchema } from './receivables.js';

const monthFigures = z.object({
  month: z.string().describe('YYYY-MM'),
  revenue: z.number(),
  expenses: z.number(),
  profit: z.number(),
});

const accountTotal = z.object({
  account: z.string().describe('Synthetic account of the Czech chart of accounts (směrná účtová osnova), e.g. 602, 518, 521'),
  amount: z.number(),
});

const vatFigures = z.object({
  period: z.string().describe('YYYY-MM for monthly payers, YYYY-Qn for quarterly'),
  start: z.string(),
  end: z.string(),
  output_vat: z.number().describe('DPH na výstupu'),
  input_vat: z.number().describe('DPH na vstupu (odpočet)'),
  to_pay: z.number().describe('Positive = to pay, negative = excess deduction (nadměrný odpočet)'),
  due_date: z.string().describe('Return and payment due (25th of the following month)'),
  days_left: z.number().describe('Negative once the due date has passed'),
  source: z.enum(['closing_document', 'invoices_estimate']),
  preliminary: z.boolean().describe('True for an estimate from invoices; the period has no closing document yet'),
  closing_document: z.string().nullable(),
  invoices_counted: z.object({ sales: z.number(), purchases: z.number() }).nullable(),
});

const accountBalance = z.object({
  bank_account_id: z.string(),
  currency: z.string(),
  balance: z.number(),
  as_of: z.string().describe('Snapshot date — the opening balance on the 1st of that month'),
});

const currencyBalance = z.object({
  currency: z.string(),
  total: z.number(),
  accounts: z.number(),
  as_of: z.string(),
  oldest_snapshot: z.string(),
});

const BANK_NOTE =
  'UOL stores monthly opening-balance snapshots (1st of the month), not live balances; always quote the as_of date.';

const VAT_NOTE =
  'Closed periods use UOL\'s "DPH" closing document (exact). Open periods are estimated from issued invoices by DUZP: ' +
  'proformas skipped, corrective invoices counted as credit notes, internal documents and reverse charge not included.';

function vatCount(kind: VatKind, requested: number | undefined): number {
  return requested ?? (kind === 'monthly' ? 4 : 2);
}

async function companyVatKind(client: UolClient) {
  const company = currentRevision((await client.myCompanies()).items ?? []);
  return { company, period: vatPeriod(company?.vat_payer_code) };
}

/** Change in percent, null when there is no base to compare with. */
function change(current: number, previous: number): number | null {
  return previous === 0 ? null : Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function comparison(summary: LedgerSummary) {
  const [previous, current] = summary.months.slice(-2);
  if (!current || !previous) return null;
  return {
    month: current.month,
    previous_month: previous.month,
    revenue_change_pct: change(current.revenue, previous.revenue),
    expenses_change_pct: change(current.expenses, previous.expenses),
    profit_change: money(current.profit - previous.profit),
  };
}

export function registerInsightTools(server: McpServer, ctx: ToolContext): void {
  registerReadTool(
    server,
    ctx,
    'get_financial_overview',
    {
      title: 'Revenue, expenses and profit by month',
      description:
        'Revenue (výnosy, class 6), expenses (náklady, class 5) and profit per month from the general ledger — the same basis as the UOL web dashboard, ' +
        'so payroll, rent and other internal documents count, not just invoices. Amounts are net of VAT, in the home currency. ' +
        'The current month is still running. Also returns the largest revenue and expense accounts for the whole window.',
      input: z.object({
        months: z.number().int().min(1).max(24).default(6).describe('Months ending with the current one'),
      }),
      output: z.object({
        as_of: z.string(),
        months: z.array(monthFigures),
        totals: z.object({ revenue: z.number(), expenses: z.number(), profit: z.number() }),
        current_vs_previous: z
          .object({
            month: z.string(),
            previous_month: z.string(),
            revenue_change_pct: z.number().nullable(),
            expenses_change_pct: z.number().nullable(),
            profit_change: z.number(),
          })
          .nullable(),
        revenue_by_account: z.array(accountTotal),
        expenses_by_account: z.array(accountTotal),
        truncated: z.boolean().describe('True when the ledger had more postings than one call reads; use fewer months'),
      }),
    },
    async ({ months }, { client }) => {
      const today = pragueDate(ctx.now());
      const summary = await ledgerSummary(client, monthKeys(today, months), today);
      const sum = (key: 'revenue' | 'expenses' | 'profit') => money(summary.months.reduce((s, m) => s + m[key], 0));
      return {
        data: {
          as_of: today,
          months: summary.months,
          totals: { revenue: sum('revenue'), expenses: sum('expenses'), profit: sum('profit') },
          current_vs_previous: comparison(summary),
          revenue_by_account: summary.revenue_by_account,
          expenses_by_account: summary.expenses_by_account,
          truncated: summary.truncated,
        },
      };
    },
  );

  registerReadTool(
    server,
    ctx,
    'get_vat_overview',
    {
      title: 'VAT by filing period',
      description:
        'VAT (DPH) per filing period, newest first: output VAT, input VAT, amount to pay or excess deduction, due date. ' +
        'The filing period (monthly / quarterly) comes from the company settings. ' +
        `${VAT_NOTE}`,
      input: z.object({
        periods: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe('Number of periods; default 4 for monthly payers, 2 for quarterly'),
      }),
      output: z.object({
        as_of: z.string(),
        vat_period: z.enum(['monthly', 'quarterly', 'not_vat_payer']),
        periods: z.array(vatFigures),
        method: z.string(),
        truncated: z.boolean(),
      }),
    },
    async ({ periods }, { client }) => {
      const today = pragueDate(ctx.now());
      const { period } = await companyVatKind(client);
      if (period === 'not_vat_payer') {
        return { data: { as_of: today, vat_period: period, periods: [], method: VAT_NOTE, truncated: false } };
      }
      const result = await vatOverview(client, period, vatCount(period, periods), today);
      return { data: { as_of: today, vat_period: period, method: VAT_NOTE, ...result } };
    },
  );

  registerReadTool(
    server,
    ctx,
    'get_bank_balances',
    {
      title: 'Bank balances',
      description: `Balances of the company's own bank accounts, per account and summed per currency. ${BANK_NOTE}`,
      input: z.object({
        history: z.boolean().default(false).describe('Also return every snapshot, newest first (up to 120)'),
      }),
      output: z.object({
        accounts: z.array(accountBalance),
        by_currency: z.array(currencyBalance),
        history: z.array(accountBalance).nullable(),
        note: z.string(),
        truncated: z.boolean().describe('True when UOL had more snapshots than one call reads'),
      }),
    },
    async ({ history }, { client }) => {
      const { rows, truncated } = await fetchPages((page, perPage) => client.bankBalances({ page, per_page: perPage }), 8);
      const accounts = latestBalances(rows);
      const snapshots = history
        ? rows
            .map((row) => latestBalances([row])[0])
            .filter((row) => row !== undefined)
            .sort((a, b) => b.as_of.localeCompare(a.as_of))
            .slice(0, 120)
        : null;
      return {
        data: { accounts, by_currency: balancesByCurrency(accounts), history: snapshots, note: BANK_NOTE, truncated },
      };
    },
  );

  registerReadTool(
    server,
    ctx,
    'get_business_snapshot',
    {
      title: 'Business snapshot',
      description:
        '"How is the company doing?" in one call: this month vs last month (revenue, expenses, profit), the current VAT period, ' +
        'unpaid and overdue receivables, uploaded documents waiting for the accountant, and bank balances. ' +
        'Sections that fail (e.g. missing permission) are null and listed in errors; sections read only partly are listed in ' +
        'incomplete. Use the dedicated tools for detail.',
      input: z.object({}),
      output: z.object({
        as_of: z.string(),
        company: z.object({ name: z.string().nullable(), vat_period: z.enum(['monthly', 'quarterly', 'not_vat_payer']) }).nullable(),
        this_month: monthFigures.nullable(),
        previous_month: monthFigures.nullable(),
        vat_current_period: vatFigures.nullable(),
        receivables: z
          .object({
            totals: z.array(receivableTotalsSchema),
            most_overdue: z.array(receivableRowSchema),
          })
          .nullable(),
        documents_to_process: z.number().nullable().describe('Uploaded documents in state unprocessed'),
        bank: z.array(currencyBalance).nullable().describe(BANK_NOTE),
        errors: z.array(z.object({ section: z.string(), message: z.string() })),
        incomplete: z
          .array(z.string())
          .describe('Sections where UOL had more rows than one call reads; their figures may be too low'),
      }),
    },
    async (_args, { client, contacts }) => {
      const today = pragueDate(ctx.now());
      const errors: { section: string; message: string }[] = [];
      const incomplete: string[] = [];
      const flag = (section: string, truncated: boolean) => {
        if (truncated) incomplete.push(section);
      };
      const attempt = async <T>(section: string, run: () => Promise<T>): Promise<T | null> => {
        try {
          return await run();
        } catch (error) {
          errors.push({ section, message: describeError(error) });
          return null;
        }
      };

      const [companyInfo, ledger, receivables, documents, bank] = await Promise.all([
        attempt('company', () => companyVatKind(client)),
        attempt('financials', async () => {
          const summary = await ledgerSummary(client, monthKeys(today, 2), today);
          flag('financials', summary.truncated);
          return summary;
        }),
        attempt('receivables', async () => {
          const { rows, truncated } = await fetchAllReceivables(client, { state: 'unpaid' });
          flag('receivables', truncated);
          const open = rows.filter((r) => !r.cancelled).map((r) => receivableRow(r, today));
          const mostOverdue = open
            .filter((r) => r.days_overdue > 0)
            .sort((a, b) => b.days_overdue - a.days_overdue)
            .slice(0, 5);
          const names = await contacts.resolve(mostOverdue.map((r) => r.customer.id));
          for (const r of mostOverdue) r.customer.name = r.customer.id ? (names.get(r.customer.id) ?? null) : null;
          return { totals: receivableTotals(open), most_overdue: mostOverdue };
        }),
        attempt('documents_to_process', async () => {
          const body = await client.uploadedDocuments({ state: 'unprocessed', page: 1, per_page: 1 });
          const items = body.items?.length ?? 0;
          return items === 0 ? 0 : (pageInfo(body, 1, 1).total_pages ?? items);
        }),
        attempt('bank', async () => {
          const { rows, truncated } = await fetchPages((page, perPage) => client.bankBalances({ page, per_page: perPage }), 8);
          flag('bank', truncated);
          return balancesByCurrency(latestBalances(rows));
        }),
      ]);

      const vat =
        companyInfo && companyInfo.period !== 'not_vat_payer'
          ? await attempt('vat', async () => {
              const overview = await vatOverview(client, companyInfo.period as VatKind, 1, today);
              flag('vat', overview.truncated);
              return overview.periods[0] ?? null;
            })
          : null;

      return {
        data: {
          as_of: today,
          company: companyInfo ? { name: str(companyInfo.company?.name), vat_period: companyInfo.period } : null,
          this_month: ledger?.months[1] ?? null,
          previous_month: ledger?.months[0] ?? null,
          vat_current_period: vat,
          receivables,
          documents_to_process: documents,
          bank: bank && bank.length > 0 ? bank : null,
          errors,
          incomplete,
        },
      };
    },
  );
}
