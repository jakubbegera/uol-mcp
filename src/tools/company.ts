import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { currentRevision } from '../domain/company.js';
import { UolApiError } from '../uol/errors.js';
import { pageInfo, refId, stripNoise, str, vatPeriod } from '../uol/normalize.js';
import { type ToolContext, registerReadTool } from './context.js';
import { limitArg, pageArg, pageInfo as pageInfoSchema } from './schemas.js';

const CODEBOOKS = {
  currencies: '/v1/currencies',
  countries: '/v1/countries',
  departments: '/v1/departments',
  contracts: '/v1/contracts',
  price_lists: '/v1/price_lists',
  product_categories: '/v1/product_categories',
  predefined_texts: '/v1/predefined_texts',
  document_templates: '/v1/document_templates',
  payment_rules: '/v1/payment_rules',
  my_bank_accounts: '/v1/my_bank_accounts',
  petty_cashes: '/v1/petty_cashes',
  uploaded_document_tags: '/v1/uploaded_document_tags',
} as const;

type Codebook = keyof typeof CODEBOOKS;

export function registerCompanyTools(server: McpServer, ctx: ToolContext): void {
  registerReadTool(
    server,
    ctx,
    'get_company',
    {
      title: 'Company details',
      description:
        'The accounting entity of this UOL tenant: name, IČO, DIČ, address and VAT filing period. ' +
        'Also a quick check that uol-mcp is connected.',
      input: z.object({}),
      output: z.object({
        name: z.string().nullable(),
        company_number: z.string().nullable().describe('IČO'),
        vatin: z.string().nullable().describe('DIČ'),
        vat_period: z.enum(['monthly', 'quarterly', 'not_vat_payer']),
        legal_entity: z.boolean().nullable().describe('true = company (právnická osoba), false = sole trader'),
        address: z.object({
          street: z.string().nullable(),
          city: z.string().nullable(),
          postal_code: z.string().nullable(),
          country: z.string().nullable(),
        }),
        email: z.string().nullable(),
        phone: z.string().nullable(),
        web: z.string().nullable(),
        register: z.string().nullable(),
        valid_from: z.string().nullable(),
        tenant: z.object({ api_url: z.string(), demo: z.boolean() }),
      }),
    },
    async (_args, { client, config }) => {
      const company = currentRevision((await client.myCompanies()).items ?? []);
      if (!company) throw new UolApiError('UOL returned no company for this tenant.', 404, '0004');
      const street = [str(company.street), str(company.building_number)].filter(Boolean).join(' ');
      return {
        data: {
          name: str(company.name),
          company_number: str(company.company_number),
          vatin: str(company.vatin),
          vat_period: vatPeriod(company.vat_payer_code),
          legal_entity: company.legal_entity ?? null,
          address: {
            street: street || null,
            city: str(company.city),
            postal_code: str(company.postal_code),
            country: refId(company.country, 'country_id'),
          },
          email: str(company.email),
          phone: str(company.phone),
          web: str(company.url),
          register: str(company.register_text),
          valid_from: str(company.valid_from),
          tenant: { api_url: client.http.baseUrl, demo: config.credentials?.isDemo ?? false },
        },
      };
    },
  );

  registerReadTool(
    server,
    ctx,
    'list_codebook',
    {
      title: 'List codebook',
      description:
        'Reference data (číselníky) used by invoices and documents: currencies, countries, departments (střediska), ' +
        'contracts (zakázky), price lists, product categories, predefined texts, document templates, payment rules, ' +
        'own bank accounts, petty cashes (pokladny) and document tags. Records are returned as UOL sends them, minus audit fields.',
      input: z.object({
        kind: z.enum(Object.keys(CODEBOOKS) as [Codebook, ...Codebook[]]),
        page: pageArg,
        limit: limitArg(250, 100),
      }),
      output: z.object({
        kind: z.string(),
        items: z.array(z.record(z.string(), z.unknown())),
        pagination: pageInfoSchema,
      }),
    },
    async ({ kind, page, limit }, { client }) => {
      const body = await client.list(CODEBOOKS[kind], { page, per_page: limit });
      return {
        data: { kind, items: (body.items ?? []).map(stripNoise), pagination: pageInfo(body, page, limit) },
      };
    },
  );
}
