import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { InputError } from '../domain/uploads.js';
import type { RawAddress, RawContact } from '../uol/client.js';
import { UolApiError } from '../uol/errors.js';
import { hrefId, stripNoise, str } from '../uol/normalize.js';
import { type ToolContext, type UolSession, registerTool } from './context.js';
import { contactRow, contactRowOf } from './contacts.js';
import { commonDetail, detailOf, purchaseRow, purchaseRowOf } from './invoices.js';
import { isoDate } from './schemas.js';
import { CONFIRM_FIRST, DESTRUCTIVE, WRITE, auditedWrite, compact } from './write-support.js';
import { PAYMENT_METHODS } from './writes.js';

/*
 * More UOL_ACCESS=write tools: contacts, received invoices, payment demands.
 * Same rules as writes.ts — dry_run everywhere, audit log, confirm first.
 */

const addressFields = {
  street: z.string().optional().describe('Street and number'),
  city: z.string().optional(),
  postal_code: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
};

type AddressInput = { [K in keyof typeof addressFields]?: string };

function hasAddress(a: AddressInput): boolean {
  return Object.keys(addressFields).some((k) => a[k as keyof AddressInput] !== undefined);
}

const contactFields = {
  company_number: z.string().optional().describe('IČO'),
  vatin: z.string().optional().describe('DIČ, e.g. CZ12345678'),
  taxable_person: z.boolean().optional().describe('true for a business (osoba povinná k dani), false for a private person'),
  vat_payer: z.boolean().optional(),
  country_id: z.string().length(2).optional().describe('ISO country code'),
  days_till_due_date: z.number().int().min(0).optional().describe('Default payment term for invoices'),
  note: z.string().optional(),
  external_id: z.string().optional(),
  ...addressFields,
};

const contactResult = contactRow.extend({ raw: z.record(z.string(), z.unknown()).describe('Stored contact as UOL returns it') });

function contactOutput(raw: RawContact) {
  return { ...contactRowOf(raw), raw: stripNoise(raw as Record<string, unknown>) };
}

const purchaseItem = z
  .object({
    description: z.string().min(1),
    quantity: z.number().default(1),
    total_price: z.number().optional().describe('Line total WITHOUT VAT'),
    total_price_with_vat: z.number().optional().describe('Line total INCLUDING VAT'),
    vat_rate: z.number().describe('VAT rate in percent: 21, 12 or 0'),
    product_id: z.string().optional().describe('UOL product id; decides how the line is booked'),
  })
  .refine((i) => (i.total_price === undefined) !== (i.total_price_with_vat === undefined), {
    message: 'Give exactly one of total_price or total_price_with_vat',
  });

export function registerRecordWriteTools(server: McpServer, ctx: ToolContext): void {
  registerTool(
    server,
    ctx,
    'create_contact',
    {
      title: 'Create a contact',
      description:
        'Adds a customer or supplier to the UOL address book (adresář). With company_number (IČO) the server first checks ' +
        `that no contact with that IČO exists. Address fields form the accounting address. ${CONFIRM_FIRST}`,
      input: z.object({
        name: z.string().min(1),
        ...contactFields,
        contact_id: z.string().optional().describe('Own id (slug); UOL derives one from the name when omitted'),
        allow_duplicate: z.boolean().default(false).describe('Create even if a contact with the same IČO exists'),
        dry_run: z.boolean().default(false),
      }),
      output: z.object({
        dry_run: z.boolean(),
        payload: z.record(z.string(), z.unknown()),
        contact: contactResult.nullable(),
      }),
    },
    WRITE,
    async (args, session) => {
      const { client } = session;
      if (args.company_number && !args.allow_duplicate) {
        const existing = (await client.contacts({ company_number: args.company_number, hidden: 'all', per_page: 5 })).items ?? [];
        if (existing.length > 0) {
          throw new InputError(
            `A contact with IČO ${args.company_number} already exists: ${existing.map((c) => `${c.name} (${c.contact_id})`).join(', ')}. ` +
              'Use it, or pass allow_duplicate=true.',
          );
        }
      }
      const address: AddressInput = args;
      const payload = compact({
        name: args.name,
        contact_id: args.contact_id,
        company_number: args.company_number,
        vatin: args.vatin,
        taxable_person: args.taxable_person,
        vat_payer: args.vat_payer,
        country_id: args.country_id?.toUpperCase() ?? 'CZ',
        days_till_due_date: args.days_till_due_date === undefined ? undefined : String(args.days_till_due_date),
        note: args.note,
        external_id: args.external_id,
        addresses: hasAddress(address)
          ? [
              compact({
                name: args.name,
                street: address.street,
                city: address.city,
                postal_code: address.postal_code,
                country_id: args.country_id?.toUpperCase() ?? 'CZ',
                email: address.email,
                phone: address.phone,
                address_types: ['accounting'],
              }),
            ]
          : undefined,
      });
      if (args.dry_run) return { data: { dry_run: true, payload, contact: null } };
      const created = await auditedWrite(
        session,
        ctx,
        { tool: 'create_contact', method: 'POST', path: '/v1/contacts', payload },
        () => client.createContact(payload),
        (c) => str(c.contact_id),
      );
      session.contacts.remember(created);
      return { data: { dry_run: false, payload, contact: contactOutput(created) } };
    },
  );

  registerTool(
    server,
    ctx,
    'update_contact',
    {
      title: 'Update a contact',
      description:
        'Changes fields of an existing contact. Address fields update its accounting address (or add one). ' +
        `Only the fields you pass change. ${CONFIRM_FIRST}`,
      input: z.object({
        contact_id: z.string(),
        name: z.string().optional(),
        ...contactFields,
        hidden: z.boolean().optional().describe('Hide the contact in the UOL interface'),
        dry_run: z.boolean().default(false),
      }),
      output: z.object({
        dry_run: z.boolean(),
        payload: z.record(z.string(), z.unknown()),
        contact: contactResult.describe('After the change, or the current state in a dry run'),
      }),
    },
    DESTRUCTIVE,
    async (args, session) => {
      const { client } = session;
      const current = await client.contact(args.contact_id);
      const address: AddressInput = args;
      const accounting: RawAddress | undefined =
        current.addresses?.find((a) => a.address_types?.includes('accounting')) ?? current.addresses?.[0];
      const payload = compact({
        name: args.name,
        company_number: args.company_number,
        vatin: args.vatin,
        taxable_person: args.taxable_person,
        vat_payer: args.vat_payer,
        country_id: args.country_id?.toUpperCase(),
        days_till_due_date: args.days_till_due_date === undefined ? undefined : String(args.days_till_due_date),
        note: args.note,
        external_id: args.external_id,
        hidden: args.hidden,
        addresses: hasAddress(address)
          ? [
              compact({
                address_id: accounting?.address_id,
                name: accounting ? undefined : (args.name ?? current.name ?? undefined),
                address_types: accounting ? undefined : ['accounting'],
                street: address.street,
                city: address.city,
                postal_code: address.postal_code,
                email: address.email,
                phone: address.phone,
              }),
            ]
          : undefined,
      });
      if (Object.keys(payload).length === 0) throw new InputError('Nothing to change — pass at least one field.');
      if (args.dry_run) return { data: { dry_run: true, payload, contact: contactOutput(current) } };
      const updated = await auditedWrite(
        session,
        ctx,
        { tool: 'update_contact', method: 'PATCH', path: `/v1/contacts/${args.contact_id}`, payload },
        () => client.updateContact(args.contact_id, payload),
        () => args.contact_id,
      );
      session.contacts.remember(updated);
      return { data: { dry_run: false, payload, contact: contactOutput(updated) } };
    },
  );

  registerTool(
    server,
    ctx,
    'create_purchase_invoice',
    {
      title: 'Record a received invoice',
      description:
        'Books a received (purchase) invoice from a supplier that already exists in contacts — e.g. after reading an uploaded PDF. ' +
        'Lines carry totals, not unit prices: total_price without VAT or total_price_with_vat. ' +
        'Stays unconfirmed unless confirm=true. Retrying with the same idempotency_key never books it twice. ' +
        `${CONFIRM_FIRST}`,
      input: z.object({
        seller_id: z.string().describe('contact_id of the supplier (search_contacts)'),
        number: z.string().describe("Supplier's invoice number"),
        items: z.array(purchaseItem).min(1).max(100),
        tax_date: isoDate.optional().describe('DUZP'),
        received_date: isoDate.optional(),
        due_date: isoDate.optional(),
        payment_method: z.enum(PAYMENT_METHODS).optional(),
        variable_symbol: z.number().int().optional(),
        constant_symbol: z.number().int().optional(),
        specific_symbol: z.number().int().optional(),
        bank_account: z.string().optional().describe("Supplier's account or IBAN to pay to"),
        currency: z.string().length(3).optional(),
        exchange_rate: z.number().positive().optional(),
        total_amount: z.number().optional().describe('Invoice total incl. VAT, as a cross-check UOL compares with the lines'),
        note: z.string().optional(),
        department_id: z.string().optional(),
        external_id: z.string().optional(),
        confirm: z.boolean().default(false).describe('true = confirm (book) it right away'),
        idempotency_key: z.string().max(255).optional(),
        dry_run: z.boolean().default(false),
      }),
      output: z.object({
        dry_run: z.boolean(),
        idempotency_key: z.string(),
        payload: z.record(z.string(), z.unknown()),
        already_existed: z.boolean(),
        invoice: purchaseRow.extend(commonDetail).nullable(),
      }),
    },
    { ...WRITE, idempotentHint: true },
    async (args, session) => {
      const { client, contacts } = session;
      await client.contact(args.seller_id).catch((error: unknown) => {
        if (error instanceof UolApiError && error.status === 404) {
          throw new InputError(`No contact with id ${args.seller_id}; look it up with search_contacts or create_contact.`);
        }
        throw error;
      });
      const idempotencyKey = args.idempotency_key ?? randomUUID();
      const payload = compact({
        seller_id: args.seller_id,
        public_id: args.number,
        tax_payment_date: args.tax_date,
        date_of_receipt: args.received_date,
        due_date: args.due_date,
        payment_method: args.payment_method,
        variable_symbol: args.variable_symbol,
        constant_symbol: args.constant_symbol,
        specific_symbol: args.specific_symbol,
        iban_or_account: args.bank_account,
        currency_id: args.currency?.toUpperCase(),
        exchange_rate: args.exchange_rate,
        total_amount: args.total_amount,
        note: args.note,
        department_id: args.department_id,
        external_id: args.external_id,
        confirmed: args.confirm ? true : undefined,
        idempotency_key: idempotencyKey,
        items: args.items.map((i) =>
          compact({
            description: i.description,
            quantity: i.quantity,
            total_price: i.total_price,
            total_price_vat_inclusive: i.total_price_with_vat,
            vat_calculation_method: i.total_price_with_vat !== undefined ? 'from_above' : 'from_below',
            vat_rate: i.vat_rate,
            product_id: i.product_id,
          }),
        ),
      });
      const base = { idempotency_key: idempotencyKey, payload };
      if (args.dry_run) return { data: { dry_run: true, ...base, already_existed: false, invoice: null } };

      const shape = async (raw: Parameters<typeof purchaseRowOf>[0]) => {
        const names = await contacts.resolve([hrefId(raw.seller)]);
        return { ...purchaseRowOf(raw, names), ...detailOf(raw) };
      };
      try {
        const created = await auditedWrite(
          session,
          ctx,
          { tool: 'create_purchase_invoice', method: 'POST', path: '/v1/purchase_invoices', payload, idempotency_key: idempotencyKey },
          () => client.createPurchaseInvoice(payload),
          (r) => str(r.invoice_id),
        );
        return { data: { dry_run: false, ...base, already_existed: false, invoice: await shape(created) } };
      } catch (error) {
        if (error instanceof UolApiError && error.code === 'validation' && /idempotency_key/.test(error.message)) {
          const existing = (await client.purchaseInvoices({ idempotency_key: idempotencyKey, per_page: 1 })).items?.[0];
          if (existing) return { data: { dry_run: false, ...base, already_existed: true, invoice: await shape(existing) } };
        }
        throw error;
      }
    },
  );

  registerTool(
    server,
    ctx,
    'create_payment_demand',
    {
      title: 'Create a payment demand',
      description:
        'Creates a payment demand (upomínka) in UOL for unpaid issued invoices of one customer. ' +
        'Every invoice is checked first: it must be issued and still unpaid. Nothing is e-mailed or posted — ' +
        `UOL only stores the document. ${CONFIRM_FIRST}`,
      input: z.object({
        invoice_ids: z.array(z.string()).min(1).max(50).describe('invoice_id values from list_receivables'),
        date: isoDate.optional().describe('Date of the demand; default today'),
        note: z.string().optional(),
        confirm: z.boolean().default(false).describe('true = confirm the demand right away'),
        dry_run: z.boolean().default(false),
      }),
      output: z.object({
        dry_run: z.boolean(),
        payload: z.record(z.string(), z.unknown()),
        invoices: z.array(z.object({ invoice_id: z.string(), customer_id: z.string().nullable(), outstanding: z.number() })),
        demand: z.record(z.string(), z.unknown()).nullable(),
      }),
    },
    WRITE,
    async (args, session) => {
      const invoices = await checkUnpaid(session, args.invoice_ids);
      const payload = compact({
        date: args.date,
        note: args.note,
        status: args.confirm ? 'confirmed' : 'valid',
        send_by_email: false,
        send_by_mail: false,
        items: args.invoice_ids.map((invoiceId) => ({ invoice_id: invoiceId })),
      });
      if (args.dry_run) return { data: { dry_run: true, payload, invoices, demand: null } };
      const demand = await auditedWrite(
        session,
        ctx,
        { tool: 'create_payment_demand', method: 'POST', path: '/v1/demands_for_payment', payload },
        () => session.client.createPaymentDemand(payload),
        (d) => str(d.reminder_id ?? d.id),
      );
      return { data: { dry_run: false, payload, invoices, demand: stripNoise(demand) } };
    },
  );
}

/** Every invoice must be an unpaid issued invoice, and all of one customer. */
async function checkUnpaid(session: UolSession, invoiceIds: string[]) {
  const rows = await Promise.all(
    invoiceIds.map(async (invoiceId) => {
      const receivable = await session.client.receivable(invoiceId).catch((error: unknown) => {
        if (error instanceof UolApiError && error.status === 404) {
          throw new InputError(`Invoice ${invoiceId} is not an issued invoice with a receivable.`);
        }
        throw error;
      });
      const outstanding = Number(receivable.total_amount ?? 0) - Number(receivable.paid_amount ?? 0);
      if (receivable.cancelled || outstanding <= 0) throw new InputError(`Invoice ${invoiceId} is not unpaid.`);
      return { invoice_id: invoiceId, customer_id: str(receivable.contact_id), outstanding: Math.round(outstanding * 100) / 100 };
    }),
  );
  const customers = new Set(rows.map((r) => r.customer_id));
  if (customers.size > 1) throw new InputError('A payment demand covers invoices of one customer; split the list per customer.');
  return rows;
}
