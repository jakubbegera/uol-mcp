# Czech tax basics the model tends to get wrong

Short reminders, not tax advice: when a case is unusual (cross-border, construction, a correction of an
old period), say so and recommend asking the accountant.

- **DUZP (datum uskutečnění zdanitelného plnění)** is the date the supply happened, not the issue date.
  For services billed per month it is usually the last day of that month; for goods, the delivery
  date. VAT and the accounting period follow DUZP.
- **15-day rule.** A VAT payer must issue the tax document within 15 days of the DUZP (or of receiving
  a payment). Issuing later is a formal breach — warn, don't block.
- **Proforma (zálohová faktura)** is not a tax document and is not revenue. When the advance is paid, a
  tax document for the received payment (daňový doklad k přijaté platbě) is due within 15 days, with
  DUZP = the payment date; the final invoice then deducts the advance.
- **Credit note (opravný daňový doklad, dobropis)** reduces revenue and VAT. UOL returns corrective
  invoices with positive amounts — treat them as negative when summing.
- **Reverse charge (přenesená daňová povinnost).** B2B services to a VAT-registered customer in another
  EU country carry no Czech VAT ("daň odvede zákazník") and go to the souhrnné hlášení; some domestic
  supplies (construction, certain goods) are reverse-charged too. Not in the VAT estimate — leave it to
  the accountant.
- **Non-payer.** A company that is not a VAT payer invoices without VAT and files no VAT return.
- **Unreliable payer (nespolehlivý plátce).** Paying a supplier who is flagged, or to an account not
  published in the VAT register, can make the payer liable for the supplier's VAT. `search_contacts`
  returns the flag.
- **Deadlines.** VAT return, payment and kontrolní hlášení: the 25th of the month after the period.
  Income tax and annual accounts follow different dates — don't guess them.
- **Rates.** 21 % standard, 12 % reduced (since 2024). Take the rate from history or the product; ask
  when unsure.
