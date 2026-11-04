/**
 * Live smoke run against the public UOL DEMO tenant: lists the tools and calls
 * each one through a real MCP client. Usage: `npm run smoke`.
 * Stays inside the rate limit (the server's own limiter paces the calls).
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig } from '../src/config.js';
import { createContext, createServer } from '../src/server.js';

const calls: [string, Record<string, unknown>][] = [
  ['get_company', {}],
  ['list_codebook', { kind: 'currencies', limit: 3 }],
  ['search_sales_invoices', { limit: 3 }],
  ['search_purchase_invoices', { limit: 3 }],
  ['list_receivables', { overdue_only: true, limit: 3 }],
  ['search_contacts', { query: 'alza', limit: 3 }],
  ['list_uploaded_documents', { limit: 3 }],
  ['api_get', { path: '/v1/products', query: { per_page: 2 } }],
  ['get_financial_overview', { months: 6 }],
  ['get_vat_overview', {}],
  ['get_bank_balances', {}],
  ['get_business_snapshot', {}],
];

async function main() {
  const ctx = createContext(loadConfig({ ...process.env, UOL_TENANT: 'demo', UOL_EMAIL: '', UOL_TOKEN: '' }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(ctx).connect(serverTransport);
  const client = new Client({ name: 'uol-mcp-smoke', version: '0.0.0' });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
  const { prompts } = await client.listPrompts();
  console.log(`${prompts.length} prompts: ${prompts.map((p) => p.name).join(', ')}`);
  const { resources } = await client.listResources();
  console.log(`${resources.length} resources: ${resources.map((r) => r.uri).join(', ')}`);
  const company = await client.readResource({ uri: 'uol://company' });
  const first = company.contents[0];
  console.log(`uol://company → ${first && 'text' in first ? first.text.slice(0, 120) : '(no text)'}\n`);

  const results = new Map<string, unknown>();
  const run = async (name: string, args: Record<string, unknown>) => {
    const started = Date.now();
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.find((c) => c.type === 'text')?.text ?? '';
    const status = result.isError ? 'ERROR' : 'ok';
    console.log(`${status.padEnd(5)} ${name} (${Date.now() - started} ms) ${text.slice(0, 300)}\n`);
    results.set(name, result.structuredContent);
    return result;
  };

  for (const [name, args] of calls) await run(name, args);

  const sales = results.get('search_sales_invoices') as { invoices: { invoice_id: string; status: string }[] };
  const issued = sales.invoices.find((i) => i.status === 'issued') ?? sales.invoices[0];
  if (issued) {
    await run('get_sales_invoice', { invoice_id: issued.invoice_id });
    await run('export_sales_invoice', { invoice_id: issued.invoice_id, format: 'pdf' });
    await run('export_sales_invoice', { invoice_id: issued.invoice_id, format: 'isdoc' });
  }
  const purchases = results.get('search_purchase_invoices') as { invoices: { invoice_id: string }[] };
  if (purchases.invoices[0]) await run('get_purchase_invoice', { invoice_id: purchases.invoices[0].invoice_id });
  const contacts = results.get('search_contacts') as { contacts: { contact_id: string }[] };
  if (contacts.contacts[0]) await run('get_contact', { contact_id: contacts.contacts[0].contact_id });
  const docs = results.get('list_uploaded_documents') as { documents: { document_id: string }[] };
  if (docs.documents[0]) {
    await run('get_uploaded_document', { document_id: docs.documents[0].document_id });
    await run('download_uploaded_document', { document_id: docs.documents[0].document_id });
  }
  await run('get_sales_invoice', { invoice_id: '9999999999' });

  await client.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
