import type { McpServer } from '@modelcontextprotocol/server';
import { INSTRUCTIONS } from './instructions.js';
import { companyDetails } from './tools/company.js';
import type { ToolContext } from './tools/context.js';

/** Longer reference than the server instructions, for clients that let the model read resources. */
export const GUIDE = `# UOL Účetnictví — guide for uol-mcp

${INSTRUCTIONS}

## Which tool for which question

| Question | Tool |
|---|---|
| How is the company doing? | get_business_snapshot |
| Revenue / expenses / profit over months, biggest cost accounts | get_financial_overview |
| VAT to pay, due date, is it final | get_vat_overview |
| Who owes us, what is overdue, has X paid | list_receivables |
| Find an issued / received invoice | search_sales_invoices / search_purchase_invoices |
| Invoice lines, VAT breakdown, payments | get_sales_invoice / get_purchase_invoice |
| Invoice PDF or ISDOC | export_sales_invoice |
| Bank balance | get_bank_balances (monthly snapshots, quote as_of) |
| Documents waiting for the accountant | list_uploaded_documents (state=unprocessed) |
| Customer / supplier details, IČO, DIČ, IBAN | search_contacts / get_contact |
| Currencies, departments, contracts, own bank accounts | list_codebook |
| Anything else in the API | api_get (raw JSON) |

## Czech chart of accounts (synthetic accounts)

Class 5 = náklady (expenses), class 6 = výnosy (revenue). Common ones: 501 material, 502 energy,
504 goods sold, 511 repairs, 512 travel, 513 representation, 518 other services, 521 wages,
524 statutory social and health insurance, 538 other taxes and fees, 548 other operating expenses,
551 depreciation, 562 interest, 563 FX losses, 568 other financial expenses, 591 income tax;
601 own products, 602 services, 604 goods, 641 sale of fixed assets, 648 other operating revenue,
662 interest, 663 FX gains.

## Limits worth knowing

- Bank balances are opening balances on the 1st of each month, not live figures.
- VAT for a period without UOL's closing document is an estimate from invoices.
- Received invoices carry no payment status in the API.
- Files are saved on the machine running uol-mcp, not uploaded anywhere.
`;

export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'guide',
    'uol://guide',
    {
      title: 'How to use uol-mcp',
      description: 'Glossary, tool selection and API limits for answering questions about UOL bookkeeping',
      mimeType: 'text/markdown',
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }] }),
  );

  server.registerResource(
    'company',
    'uol://company',
    {
      title: 'Company',
      description: 'The accounting entity of the connected UOL tenant (same data as get_company)',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await companyDetails(ctx.session())) },
      ],
    }),
  );
}
