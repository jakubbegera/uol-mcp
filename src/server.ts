import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { type AppConfig, ConfigError, TOOLSETS } from './config.js';
import { INSTRUCTIONS } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerCompanyTools } from './tools/company.js';
import { registerContactTools } from './tools/contacts.js';
import { type ToolContext, UolSession } from './tools/context.js';
import { registerDocumentTools } from './tools/documents.js';
import { registerInsightTools } from './tools/insights.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerRawTools } from './tools/raw.js';
import { registerReceivableTools } from './tools/receivables.js';
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
  let session: UolSession | undefined;
  return {
    config,
    now: deps.now ?? (() => new Date()),
    session() {
      if (config.configError) throw new ConfigError(config.configError);
      if (!config.credentials) throw new ConfigError('no UOL credentials configured');
      session ??= new UolSession(
        config,
        new UolHttp(config.credentials, {
          fetch: deps.fetch,
          limiter: deps.limiter,
          timeoutMs: config.requestTimeoutMs,
          debug: config.debug,
        }),
      );
      return session;
    },
  };
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'uol-mcp', title: 'UOL Účetnictví', version: VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );
  const toolsets = ctx.config.toolsets ?? new Set(TOOLSETS);
  // Registration order is the tools/list order; keep it stable.
  if (toolsets.has('core')) {
    registerCompanyTools(server, ctx);
    registerInvoiceTools(server, ctx);
    registerReceivableTools(server, ctx);
    registerContactTools(server, ctx);
    registerDocumentTools(server, ctx);
    registerRawTools(server, ctx);
  }
  if (toolsets.has('insights')) registerInsightTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, toolsets);
  return server;
}
