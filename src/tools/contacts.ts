import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawAddress, RawContact } from '../uol/client.js';
import { bool, pageInfo, refId, str } from '../uol/normalize.js';
import { type ToolContext, registerReadTool } from './context.js';
import { limitArg, pageArg, pageInfo as pageInfoSchema } from './schemas.js';

export const contactRow = z.object({
  contact_id: z.string().describe('Usable with get_contact and as buyer_id / seller_id / customer_id filters'),
  name: z.string().nullable(),
  company_number: z.string().nullable().describe('IČO'),
  vatin: z.string().nullable().describe('DIČ'),
  country: z.string().nullable(),
  city: z.string().nullable(),
  email: z.string().nullable(),
  taxable_person: z.boolean().nullable().describe('Business (osoba povinná k dani) vs private person'),
  vat_payer: z.boolean().nullable(),
  unreliable_payer: z.boolean().nullable().describe('Flagged as nespolehlivý plátce DPH'),
  hidden: z.boolean().nullable(),
});

const address = z.object({
  types: z.array(z.string()),
  name: z.string().nullable(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});

/** The accounting (billing) address, else the first one. */
function primaryAddress(contact: RawContact): RawAddress | undefined {
  const addresses = contact.addresses ?? [];
  return addresses.find((a) => a.address_types?.includes('accounting')) ?? addresses[0];
}

export function contactRowOf(contact: RawContact): z.output<typeof contactRow> {
  const primary = primaryAddress(contact);
  return {
    contact_id: contact.contact_id ?? '',
    name: str(contact.name),
    company_number: str(contact.company_number),
    vatin: str(contact.vatin),
    country: str(contact.country_id),
    city: str(primary?.city),
    email: str(primary?.email),
    taxable_person: bool(contact.taxable_person),
    vat_payer: bool(contact.vat_payer),
    unreliable_payer: bool(contact.unreliable_payer),
    hidden: bool(contact.hidden),
  };
}

function addressOf(a: RawAddress): z.output<typeof address> {
  const street = [str(a.street), str(a.building_number)].filter(Boolean).join(' ');
  return {
    types: a.address_types ?? [],
    name: str(a.name),
    street: street || null,
    city: str(a.city),
    postal_code: str(a.postal_code),
    country: str(a.country_id),
    email: str(a.email),
    phone: str(a.phone) ?? str(a.mobile_phone),
  };
}

export function registerContactTools(server: McpServer, ctx: ToolContext): void {
  registerReadTool(
    server,
    ctx,
    'search_contacts',
    {
      title: 'Search contacts',
      description:
        'Search customers and suppliers (kontakty / adresář) by name, IČO or DIČ. ' +
        'Returns contact_id values for the invoice and receivable filters.',
      input: z.object({
        query: z.string().optional().describe('Full-text: name, contact id or note'),
        name: z.string().optional().describe('Name as UOL matches it; for part of a name use query'),
        company_number: z.string().optional().describe('IČO'),
        vatin: z.string().optional().describe('DIČ, e.g. CZ12345678'),
        country: z.string().optional().describe('ISO country code, e.g. CZ'),
        taxable_person: z.boolean().optional().describe('true = businesses only, false = private persons only'),
        include_hidden: z.boolean().default(false),
        page: pageArg,
        limit: limitArg(),
      }),
      output: z.object({ contacts: z.array(contactRow), pagination: pageInfoSchema }),
    },
    async (args, { client, contacts }) => {
      const body = await client.contacts({
        q: args.query,
        name: args.name,
        company_number: args.company_number,
        vatin: args.vatin,
        country: args.country,
        taxable_person: args.taxable_person === undefined ? undefined : args.taxable_person ? 'yes' : 'no',
        hidden: args.include_hidden ? 'all' : 'no',
        page: args.page,
        per_page: args.limit,
      });
      const raws = body.items ?? [];
      raws.forEach((c) => contacts.remember(c));
      return { data: { contacts: raws.map(contactRowOf), pagination: pageInfo(body, args.page, args.limit) } };
    },
  );

  registerReadTool(
    server,
    ctx,
    'get_contact',
    {
      title: 'Get contact',
      description: 'One contact with all addresses, bank accounts and default payment terms.',
      input: z.object({ contact_id: z.string().describe('contact_id, e.g. from search_contacts or an invoice') }),
      output: contactRow.extend({
        note: z.string().nullable(),
        external_id: z.string().nullable(),
        days_till_due_date: z.number().nullable().describe('Default payment term in days'),
        addresses: z.array(address),
        bank_accounts: z.array(
          z.object({
            account_number: z.string().nullable(),
            iban: z.string().nullable(),
            currency: z.string().nullable(),
            default: z.boolean().nullable(),
          }),
        ),
      }),
    },
    async ({ contact_id }, { client, contacts }) => {
      const raw = await client.contact(contact_id);
      contacts.remember(raw);
      return {
        data: {
          ...contactRowOf(raw),
          note: str(raw.note),
          external_id: str(raw.external_id),
          days_till_due_date: raw.days_till_due_date ?? null,
          addresses: (raw.addresses ?? []).map(addressOf),
          bank_accounts: (raw.bank_accounts ?? []).map((b) => ({
            account_number: str(b.bank_account),
            iban: str(b.iban),
            currency: refId(b.currency, 'currency_id'),
            default: b.default ?? null,
          })),
        },
      };
    },
  );
}
