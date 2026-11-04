import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { type AppConfig, ConfigError, DEFAULT_TOOLSETS, type UolCredentials } from './config.js';
import { InputError } from './domain/uploads.js';
import { INSTRUCTIONS } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerBankingTools } from './tools/banking.js';
import { registerCompanyTools } from './tools/company.js';
import { registerContactTools } from './tools/contacts.js';
import { type ToolContext, UolSession } from './tools/context.js';
import { registerDestructiveTools } from './tools/destructive.js';
import { registerDocumentTools } from './tools/documents.js';
import { registerInsightTools } from './tools/insights.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerLedgerTools } from './tools/ledger.js';
import { registerRawTools } from './tools/raw.js';
import { registerReceivableTools } from './tools/receivables.js';
import { registerWarehouseTools } from './tools/warehouse.js';
import { registerWriteTools } from './tools/writes.js';
import { registerDocumentWriteTools } from './tools/writes-documents.js';
import { registerRecordWriteTools } from './tools/writes-records.js';
import { UolHttp } from './uol/http.js';
import type { RateLimiter } from './uol/rate-limit.js';

export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export interface Dependencies {
  fetch?: typeof fetch;
  limiter?: RateLimiter;
  now?: () => Date;
}

/**
 * One context per process: the session (HTTP client, caches, rate limiter)
 * must be shared by every server instance the transport creates, otherwise
 * each instance would keep its own rate-limit budget.
 */
export function createContext(config: AppConfig, deps: Dependencies = {}): ToolContext {
  // One session per account; each gets its own rate limiter, since UOL limits per user.
  const sessions = new Map<string, UolSession>();
  return {
    config,
    now: deps.now ?? (() => new Date()),
    session(account?: string) {
      if (config.configError) throw new ConfigError(config.configError);
      const { key, credentials } = pickAccount(config, account);
      let session = sessions.get(key);
      if (!session) {
        session = new UolSession(
          { ...config, credentials },
          new UolHttp(credentials, {
            fetch: deps.fetch,
            limiter: deps.limiter,
            timeoutMs: config.requestTimeoutMs,
            debug: config.debug,
          }),
        );
        sessions.set(key, session);
      }
      return session;
    },
  };
}

function pickAccount(config: AppConfig, account: string | undefined): { key: string; credentials: UolCredentials } {
  if (config.accounts && config.accounts.length > 0) {
    const name = account ?? config.defaultAccount;
    const found = config.accounts.find((a) => a.name === name);
    if (!found) {
      throw new InputError(`Unknown account "${name}"; available: ${config.accounts.map((a) => a.name).join(', ')}.`);
    }
    return { key: found.name, credentials: found.credentials };
  }
  if (account) throw new InputError('This server is configured for a single UOL tenant; leave account out.');
  if (!config.credentials) throw new ConfigError('no UOL credentials configured');
  return { key: '', credentials: config.credentials };
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'uol-mcp', title: 'UOL Účetnictví', version: VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );
  const toolsets = ctx.config.toolsets ?? new Set(DEFAULT_TOOLSETS);
  // Registration order is the tools/list order; keep it stable.
  if (ctx.config.accounts && ctx.config.accounts.length > 0) registerAccountTools(server, ctx);
  if (toolsets.has('core')) {
    registerCompanyTools(server, ctx);
    registerInvoiceTools(server, ctx);
    registerReceivableTools(server, ctx);
    registerContactTools(server, ctx);
    registerDocumentTools(server, ctx);
    registerRawTools(server, ctx);
  }
  if (toolsets.has('insights')) registerInsightTools(server, ctx);
  if (toolsets.has('ledger')) registerLedgerTools(server, ctx);
  if (toolsets.has('banking')) registerBankingTools(server, ctx);
  if (toolsets.has('warehouse')) registerWarehouseTools(server, ctx);
  if (ctx.config.access === 'write' || ctx.config.access === 'full') {
    registerWriteTools(server, ctx);
    registerRecordWriteTools(server, ctx);
    registerDocumentWriteTools(server, ctx);
  }
  if (ctx.config.access === 'full') registerDestructiveTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, toolsets);
  return server;
}
