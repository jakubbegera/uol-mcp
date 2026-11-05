# Revenue, expenses, profit, VAT, receivables, bank

The numbers in UOL are easy to fetch and easy to get wrong. Invoices are not the books: rent, payroll,
travel, depreciation and FX differences are booked through internal documents, credit notes reverse
revenue, and the accountant books each month some time after it ends. The tools below already apply the
rules; your job is to pick the right one and to say clearly what is final and what is not.

## Revenue, expenses, profit (výnosy, náklady, výsledek hospodaření)

Use `get_financial_overview` (months ending with the current one; for "letos" pass the months since
January). It reads the general ledger the way the UOL dashboard does:

- class 6 = revenue, class 5 = expenses, both sides of each account (a credit note or reversal reduces
  revenue), amounts in the home currency (`accounting_amount`), net of VAT;
- postings against class 7 (year-end closing) are left out, otherwise December would vanish;
- profit is before income tax unless 591 is already booked.

Read these fields before answering:

- `booked: false` on a month means nothing is booked yet — say "ještě nezaúčtováno", never "nulové tržby".
  `booked_through` is the date of the latest posting; quote it ("zaúčtováno do 30. 9.").
- The current month is always partial.
- `revenue_by_account` / `expenses_by_account` name the biggest accounts (518 Ostatní služby, 521 Mzdové
  náklady…) — use them for "na čem nejvíc utrácíme".

Don't rebuild profit from invoices: issued minus received invoices misses payroll, depreciation and
internal documents, counts proformas and assets wrongly, and mixes the DUZP month with the booking month.
If the user wants invoiced amounts, say that is "vyfakturováno", a different number, and use
`search_sales_invoices` by `tax_date`.

## VAT (DPH)

Use `get_vat_overview` (or `vat_due_next` in `get_business_snapshot` for "kolik zaplatím").

- The filing period (monthly / quarterly) comes from the company; a non-payer has no VAT at all.
- A period with UOL's closing document (an internal document "DPH …") is exact. It is in whole crowns,
  as filed; the UOL web VAT report shows hellers, so a difference below 1 Kč is rounding, not an error.
- Without a closing document the figure is an estimate from invoices — output VAT by DUZP, input VAT in
  the period of the later of DUZP and the receipt date (a supplier invoice dated 30 June that arrived on
  2 July is deducted in July, as in UOL's own report); proformas skipped, credit notes subtracted,
  internal documents and reverse charge not included — and `preliminary` is true. Say "odhad" until the
  accountant closes it. A period past its due date with no closing document usually means the return was
  filed but the closing entry isn't booked yet — say so rather than "nezaplaceno".
- Return and payment are due on the 25th of the following month (after the quarter for quarterly
  payers); `days_left` counts down to it. The period due next is usually the previous month, not the
  running one.
- Some companies expose no internal documents through the API; then every period is an estimate and
  the `method` text says so.
- Positive `to_pay` = to pay, negative = excess deduction (nadměrný odpočet) the tax office will refund.

## Receivables (pohledávky) and reminders

- `list_receivables` covers issued invoices only (standard, proforma, corrective). The API has no
  payment status for received invoices, so there are no payables (závazky) here — say so rather than
  guessing whether a supplier was paid, and point to "Závazky" on the UOL dashboard.
- Payment status depends on the accountant pairing bank statements: an invoice paid yesterday may still
  show as unpaid. Mention it when the user is about to send a reminder.
- `overdue_followup` (prompt) drafts reminders; `create_payment_demand` creates an upomínka in UOL but
  never sends it.

## Bank balances

`get_bank_balances` returns monthly opening balances (1st of the month), not live ones. Always quote
`as_of`; for the current balance the user has to look at the bank.

## The one-call overview

`get_business_snapshot` for "jak si stojíme": this and last month (with `booked`), `booked_through`,
`vat_due_next`, receivables, documents waiting for the accountant, bank. Sections can fail on their own
(`errors`) or be partial (`incomplete`) — report that instead of hiding it.

## Cross-checking with the UOL web

When numbers will be used for a decision (a VAT payment, a dividend, a bank), suggest checking them in
the UOL web. Where to look, and what should match:

| Figure | UOL web | Expect |
|---|---|---|
| Revenue, expenses, profit per month | Reporty → Náklady a výnosy (or "Detail" on the dashboard chart) | Same ledger: equal to the crown. |
| VAT for a period | Reporty → Přehled DPH, pick the period | Open periods equal to the heller; closed ones within 1 Kč (rounding). |
| Receivables | Dashboard → Pohledávky | Same total. |
| Payables | Dashboard → Závazky | Not available through the API. |

A bigger difference usually means a month booked after the call, a closing entry, internal documents
or reverse charge in a period without a closing document, or a VAT-ratio (koeficient) other than 100.
