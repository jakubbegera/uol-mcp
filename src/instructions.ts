/**
 * Server instructions — sent to the client once and usually placed in the
 * model's context. Only facts the model needs to use the tools correctly.
 */
export const INSTRUCTIONS = `uol-mcp reads a company's bookkeeping in UOL Účetnictví (Czech online accounting).

Domain notes:
- Users usually speak Czech. Vydaná faktura = issued/sales invoice, přijatá faktura = received/purchase invoice, pohledávka = receivable, DUZP = taxable supply date (tax_date), IČO = company_number, DIČ = vatin, středisko = department, zakázka = contract.
- Invoice status: draft (koncept), issued (vystavená), cancelled (storno). Only issued invoices count as revenue or receivables.
- Accounting periods and VAT follow DUZP (tax_date), not the issue date.
- Payment status exists only for issued (sales) invoices, via list_receivables / get_sales_invoice. The UOL API has no payment information for received invoices — say so rather than guessing.
- Amounts are in the document currency; total includes VAT, total_without_vat is the tax base. Never add different currencies together.
- Ids: invoice_id is internal; number is what is printed on the invoice. Contacts are referenced by contact_id (a slug).
- Files (PDF/ISDOC exports, uploaded documents) are saved on the machine running uol-mcp; report the returned file_path.
- UOL allows ~30 requests per 10 seconds. Prefer one well-filtered call over many page-by-page calls.`;
