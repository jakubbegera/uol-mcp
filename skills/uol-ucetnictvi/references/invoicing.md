# Issuing an invoice the way the company does it

Most companies invoice the same customer the same way every time: the same DUZP rule, the same due
period, the same products and line texts, the same bank account. The user usually says only what
changed ("za říjen 120 hodin"). Learn the rest from the customer's earlier invoices instead of asking
for it or falling back to defaults that don't match.

## 1. Company and customer

1. With several accounts, settle the company first (`list_accounts`).
2. Find the customer with `search_contacts`: part of the name in `query` (`name` wants the name as UOL
   stores it and misses partial names), IČO in `company_number`. Several matches or none → show what
   you found and ask. Note `unreliable_payer`: if it is true, warn the user before going on (VAT on a
   payment to an unreliable payer's account is a liability risk).
3. `list_receivables` with `customer_id` and `overdue_only: true`: if the customer owes money past its
   due date, mention it — the user may want to wait or send a reminder with the new invoice.
4. `get_company` tells whether the company is a VAT payer (`vat_period` is `not_vat_payer` otherwise);
   a non-payer issues invoices without VAT.

## 2. Learn the pattern from history

1. `search_sales_invoices` with `buyer_id`, newest first, `limit` 20 — enough for at least three billed
   periods. Some companies issue several invoices per period to one customer (one per project or
   service), so six rows can be a single month. Learn from issued standard invoices; skip proformas and
   credit notes unless the user asks for one of those.
2. `get_sales_invoice` for every invoice of the latest period (and one of an earlier period to confirm)
   to see lines and payment details. On an older uol-mcp without `bank_account_id` in the result, read
   it with `api_get` `/v1/sales_invoices/<invoice_id>` (`bank_account.bank_account_id`).
3. Derive, and keep the evidence:

| What | How to read it from history |
|---|---|
| DUZP rule | Compare `tax_date` with `issue_date` and with the period billed. Typical: last day of the billed month (monthly services billed afterwards), or the delivery / issue day. A month-end DUZP stays on the last calendar day even when it is a weekend — DUZP is when the supply happened, not a working day. |
| When it is issued | Days between DUZP and `issue_date` (e.g. the 15th of the next month). |
| Invoices per period | One, or several (per project, per service). If several, which lines go on which invoice — ask which one the user means, or prepare all of them. |
| Due period | `due_date` − `issue_date` in days. If it varies, take the most recent and show the variants. |
| Lines | `product_id`, `description` (often one line per project or service), `quantity`, unit price and `price_includes_vat` (repeat the same convention: `unit_price` or `unit_price_with_vat`), `vat_rate`. The unit (hours, pieces) comes from the product — don't write it into the description. |
| Recurring lines | Lines that appear every period with the same amount (a monthly fee, maintenance, a licence). |
| Payment | `payment_method`, `bank_account_id`, `constant_symbol`, `specific_symbol` (some customers want e.g. their IČO there); `variable_symbol` is usually the invoice number — leave it out and UOL fills it. |
| Header | `currency`, `text`, `note`, `department_id`, `contract_id` when they repeat. |

4. Tell the user the pattern in two or three lines with the evidence ("posledních 5 faktur: DUZP
   poslední den fakturovaného měsíce, vystaveno do 15. dne dalšího měsíce, splatnost 14 dní, řádky po
   projektech, 1 200 Kč/h bez DPH, 21 %"). If invoices disagree, show the variants and ask which to use.
   No history (a new customer) → ask for what the request leaves open, and let UOL's defaults fill dates.
5. **Duplicates.** If the history already has an invoice for the period being billed — issued or a draft
   (check `status`) — show it and ask before preparing another one.

## 3. Build the invoice

- Take what the user said (period, quantities, prices, extra lines) and fill everything else from the
  pattern. "Za říjen" with a month-end DUZP rule means `tax_date` = last day of October.
- Recurring lines the user didn't mention: don't add or drop them silently — ask ("v historii je každý
  měsíc i paušál za podporu 5 000 Kč, přidat?").
- Dates: `issue_date` is today unless the user says otherwise — never backdate it to match the pattern;
  `due_date` = issue date + the usual days. Check the 15-day rule (see czech-tax-basics.md): if the
  issue date is more than 15 days after the DUZP, warn the user.
- Lines need an existing `product_id` from `list_codebook` (`kind: products`); reuse the one from
  history. Never invent one.
- Prices: keep the same convention as history (usually without VAT). If the user's amount is ambiguous
  (s DPH / bez DPH), ask.

## 4. Dry run, confirmation, draft

1. `create_sales_invoice` with `dry_run: true`. It validates the customer and returns the payload and an
   `idempotency_key`; it does not compute totals, so compute them from the lines yourself.
2. Show the summary: company, customer (name, IČO), lines (text, quantity, unit price bez DPH, VAT
   rate), total without VAT, VAT, total with VAT, issue date, DUZP, due date, bank account, draft or
   issued. Mark which values came from the request and which from the pattern.
3. Wait for an explicit yes. Then call `create_sales_invoice` with the same data, `dry_run: false` and
   the same `idempotency_key` (a retry then cannot create a second invoice), `issue: false`.
4. Report `invoice_id`, number, status and UOL's totals (flag any difference from your summary), and
   offer: issue it now (`update_sales_invoice` with `issue: true`, after another yes), the PDF
   (`export_sales_invoice`), or changes while it is a draft.

Without write tools, stop once the invoice is built (section 3): show the full proposal in the format of
section 4, step 2, and say that creating it needs write access for this company.

## Corrections and credit notes

Issued invoices can't be edited. A mistake on an issued invoice means a corrective invoice
(`type: corrective`, a credit note / dobropis) or a storno (`repair_sales_invoice`, full access only);
explain the difference and let the user — or their accountant — choose.
