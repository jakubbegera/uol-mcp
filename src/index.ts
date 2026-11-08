#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, SETUP_HINT, loadConfig } from './config.js';
import { currentRevision } from './domain/company.js';
import { httpMode, httpOptionsFromEnv, startHttpServer } from './http.js';
import { VERSION, createContext, createServer } from './server.js';
import { describeError } from './tools/context.js';
import { vatPeriod } from './uol/normalize.js';

const HELP = `uol-mcp ${VERSION} — MCP server for the UOL Účetnictví API

Usage:
  uol-mcp            run the MCP server over stdio (what MCP clients start)
  uol-mcp --http     run it over Streamable HTTP at http://HOST:PORT/mcp
  uol-mcp doctor     check the configuration against the UOL API
  uol-mcp --version
  uol-mcp --help

Environment:
  UOL_TENANT         "demo", a tenant name ("firma" → https://firma.ucetnictvi.uol.cz)
                     or a full https://….uol.cz URL
  UOL_EMAIL          UOL login e-mail
  UOL_TOKEN          API token (UOL → /api_tokens)
  UOL_ACCESS         read (default) or write — write adds upload / invoice tools
  UOL_DOWNLOAD_DIR   where exported / downloaded files are saved
  UOL_UPLOAD_DIRS    folders upload_document may read from
  UOL_AUDIT_LOG      JSONL file recording every write
  UOL_TOOLSETS       core, insights (default), ledger, banking, warehouse or all
  UOL_PROMPT_LANGUAGE  cs (default) or en — language of the prompts (slash commands)
  UOL_ACCOUNTS       several tenants: a,b plus UOL_ACCOUNT_A_TENANT / _EMAIL / _TOKEN / _LABEL / _ACCESS
  UOL_PROFILES_FILE  several tenants from a JSON file instead
  UOL_DEBUG=1        log requests to stderr

HTTP (--http or MCP_TRANSPORT=http):
  HOST, PORT         bind address, default 127.0.0.1:3000
  MCP_AUTH_TOKEN     bearer token clients must send (32+ characters); required when UOL_* credentials
                     are set or HOST is not a loopback address
  MCP_ALLOWED_HOSTS  accepted Host names (comma-separated); required when HOST is not a loopback address
  Without UOL_* credentials every request brings X-UOL-Tenant, X-UOL-Email, X-UOL-Token.
`;

/** Checks every configured account (or the single tenant) against the API. */
async function doctor(): Promise<number> {
  const config = loadConfig();
  for (const warning of config.warnings ?? []) console.error(`WARN  ${warning}`);
  const ctx = createContext(config);
  const accounts = config.accounts?.map((a) => a.name) ?? [undefined];
  let failures = 0;
  for (const account of accounts) {
    const label = account ? `[${account}${account === config.defaultAccount ? ', default' : ''}] ` : '';
    try {
      const { client } = ctx.session(account);
      await client.ping();
      const company = currentRevision((await client.myCompanies()).items ?? []);
      console.log(`OK  ${label}${client.http.baseUrl}`);
      console.log(`    ${company?.name ?? '(no company)'} · IČO ${company?.company_number ?? '—'} · VAT ${vatPeriod(company?.vat_payer_code)}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL  ${label}${describeError(error)}`);
    }
  }
  console.log(`    access ${config.access ?? 'read'} · downloads → ${config.downloadDir}`);
  return failures === 0 ? 0 : 1;
}

async function serveHttp(): Promise<void> {
  const config = loadConfig();
  for (const warning of config.warnings ?? []) process.stderr.write(`uol-mcp: ${warning}\n`);
  const options = httpOptionsFromEnv();
  try {
    await startHttpServer(config, options);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`uol-mcp: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(
    `uol-mcp ${VERSION}: ${httpMode(config)} MCP endpoint on http://${options.host}:${options.port}/mcp\n`,
  );
}

const MIN_NODE_MAJOR = 22;

async function main(): Promise<void> {
  // `engines` only warns under npm, and a plain `node dist/index.js` skips it
  // entirely — older runtimes then fail later with "fetch is not defined".
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `uol-mcp needs Node.js ${MIN_NODE_MAJOR} or newer, but runs on ${process.version} (${process.execPath}).\n`,
    );
    process.exitCode = 1;
    return;
  }

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
  if (arg === '--http' || (!arg && process.env.MCP_TRANSPORT === 'http')) {
    await serveHttp();
    return;
  }
  if (arg) {
    console.error(`Unknown argument: ${arg}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  for (const warning of config.warnings ?? []) process.stderr.write(`uol-mcp: ${warning}\n`);
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
