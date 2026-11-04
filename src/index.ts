#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { SETUP_HINT, loadConfig } from './config.js';
import { currentRevision } from './domain/company.js';
import { VERSION, createContext, createServer } from './server.js';
import { describeError } from './tools/context.js';
import { vatPeriod } from './uol/normalize.js';

const HELP = `uol-mcp ${VERSION} — MCP server for the UOL Účetnictví API

Usage:
  uol-mcp            run the MCP server over stdio (what MCP clients start)
  uol-mcp doctor     check the configuration against the UOL API
  uol-mcp --version
  uol-mcp --help

Environment:
  UOL_TENANT         "demo", a tenant name ("firma" → https://firma.ucetnictvi.uol.cz)
                     or a full https://….uol.cz URL
  UOL_EMAIL          UOL login e-mail
  UOL_TOKEN          API token (UOL → /api_tokens)
  UOL_DOWNLOAD_DIR   where exported / downloaded files are saved
  UOL_DEBUG=1        log requests to stderr
`;

async function doctor(): Promise<number> {
  const config = loadConfig();
  const ctx = createContext(config);
  try {
    const { client } = ctx.session();
    await client.ping();
    const company = currentRevision((await client.myCompanies()).items ?? []);
    console.log(`OK  ${client.http.baseUrl}`);
    console.log(`    ${company?.name ?? '(no company)'} · IČO ${company?.company_number ?? '—'} · VAT ${vatPeriod(company?.vat_payer_code)}`);
    console.log(`    downloads → ${config.downloadDir}`);
    return 0;
  } catch (error) {
    console.error(`FAIL  ${describeError(error)}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === '--version' || arg === '-v') {
    console.log(VERSION);
    return;
  }
  if (arg === '--help' || arg === '-h') {
    console.log(HELP);
    return;
  }
  if (arg === 'doctor') {
    process.exitCode = await doctor();
    return;
  }
  if (arg) {
    console.error(`Unknown argument: ${arg}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  if (config.configError) process.stderr.write(`uol-mcp: ${config.configError}\n`);
  else if (!config.credentials) process.stderr.write(`uol-mcp: not configured. ${SETUP_HINT}\n`);
  const ctx = createContext(config);
  serveStdio(() => createServer(ctx), {
    onerror: (error) => process.stderr.write(`uol-mcp: ${error.message}\n`),
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`uol-mcp: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
