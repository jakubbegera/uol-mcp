import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer as createHttpServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { type AppConfig, ConfigError, DEMO, resolveTenant } from './config.js';
import { type Dependencies, VERSION, createContext, createServer } from './server.js';
import type { ToolContext } from './tools/context.js';

/*
 * Streamable HTTP transport. Two modes, picked from the configuration:
 *
 *  - single-tenant: the server holds UOL credentials from its env; every caller
 *    acts as that UOL user, so a bearer token (MCP_AUTH_TOKEN) is mandatory;
 *  - pass-through: the server holds none; each request brings its own
 *    X-UOL-Tenant / X-UOL-Email / X-UOL-Token headers and nothing is stored.
 *
 * Spec 2026-07-28 is stateless, so every request gets a fresh McpServer; only
 * the per-user context (HTTP client, rate limiter, caches) is reused.
 */

export interface HttpOptions {
  host: string;
  port: number;
  /** Required in single-tenant mode, optional in pass-through mode. */
  authToken?: string;
  /** Host header names accepted; defaults to localhost names on a loopback bind, anything otherwise. */
  allowedHosts?: string[];
  /** Browser origins accepted (hostnames); requests without Origin are always allowed. */
  allowedOrigins?: string[];
}

const LOCAL_NAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];
const MAX_CONTEXTS = 100;
/** 32 characters, e.g. `openssl rand -hex 16`; shorter tokens are guessable. */
const MIN_AUTH_TOKEN_LENGTH = 32;
const CONTEXT_TTL_MS = 30 * 60_000;

export const HEADER = {
  tenant: 'x-uol-tenant',
  email: 'x-uol-email',
  token: 'x-uol-token',
} as const;

export function httpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const list = (raw: string | undefined) =>
    raw
      ?.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: Number(env.PORT) > 0 ? Number(env.PORT) : 3000,
    authToken: env.MCP_AUTH_TOKEN?.trim() || undefined,
    allowedHosts: list(env.MCP_ALLOWED_HOSTS),
    allowedOrigins: list(env.MCP_ALLOWED_ORIGINS),
  };
}

type Mode = 'single-tenant' | 'pass-through';

export function httpMode(config: AppConfig): Mode {
  return config.credentials || config.configError ? 'single-tenant' : 'pass-through';
}

/** Builds the request listener; separate from listen() so tests can drive it. */
export function createHttpHandler(baseConfig: AppConfig, options: HttpOptions, deps: Dependencies = {}) {
  // file_path uploads would read this machine's disk on behalf of remote callers, so the
  // default folders don't apply here; clients send content_base64 unless the operator opts in.
  const config: AppConfig = {
    ...baseConfig,
    embedFiles: true,
    uploadDirs: baseConfig.explicitUploadDirs ? baseConfig.uploadDirs : [],
  };
  const mode = httpMode(config);
  const loopback = LOCAL_NAMES.includes(options.host);
  if (mode === 'single-tenant' && !options.authToken) {
    throw new ConfigError('MCP_AUTH_TOKEN is required when the HTTP server holds UOL credentials');
  }
  if (options.authToken && options.authToken.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new ConfigError(
      `MCP_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters; generate one with \`openssl rand -hex 32\``,
    );
  }
  // Beyond localhost, anyone who can reach the port could otherwise use the server (or flood its
  // per-user contexts), and without a Host allowlist DNS rebinding could reach it from a browser.
  if (!loopback && !options.authToken) {
    throw new ConfigError(`HOST ${options.host} is not a loopback address; set MCP_AUTH_TOKEN`);
  }
  if (!loopback && !options.allowedHosts?.length) {
    throw new ConfigError(`HOST ${options.host} is not a loopback address; set MCP_ALLOWED_HOSTS to the host names clients use`);
  }

  const shared = mode === 'single-tenant' ? createContext(config, deps) : undefined;
  const contexts = new Map<string, { ctx: ToolContext; used: number }>();

  /** One context per UOL user, so each keeps its own rate-limit budget and caches. */
  const contextFor = (headers: Headers): ToolContext => {
    if (shared) return shared;
    const { baseUrl, isDemo } = resolveTenant(headers.get(HEADER.tenant) ?? '');
    const given = { email: headers.get(HEADER.email)?.trim() ?? '', token: headers.get(HEADER.token)?.trim() ?? '' };
    // Same rule as the env config: the DEMO tenant falls back to its published credentials.
    const { email, token } = isDemo && !given.email && !given.token ? DEMO : given;
    const key = createHash('sha256').update(`${baseUrl}\n${email}\n${token}`).digest('hex');
    const now = Date.now();
    for (const [k, v] of contexts) if (now - v.used > CONTEXT_TTL_MS) contexts.delete(k);
    // Least recently used first: a reused entry moves to the end, eviction takes the front.
    let entry = contexts.get(key);
    if (entry) {
      contexts.delete(key);
    } else {
      if (contexts.size >= MAX_CONTEXTS) contexts.delete(contexts.keys().next().value!);
      entry = { ctx: createContext({ ...config, credentials: { baseUrl, email, token, isDemo } }, deps), used: now };
    }
    entry.used = now;
    contexts.set(key, entry);
    return entry.ctx;
  };

  const mcp = toNodeHandler(
    createMcpHandler(({ requestInfo }) => createServer(contextFor(requestInfo?.headers ?? new Headers()))),
  );

  const allowedHosts = options.allowedHosts ?? LOCAL_NAMES;
  const allowedOrigins = options.allowedOrigins ?? LOCAL_NAMES;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/health') return send(res, 200, { status: 'ok', version: VERSION, mode });
    if (path !== '/mcp') return send(res, 404, { error: 'not_found', message: 'The MCP endpoint is /mcp' });

    const host = hostname(req.headers.host);
    if (!host || !allowedHosts.includes(host)) {
      return send(res, 403, { error: 'forbidden_host', message: `Host ${req.headers.host ?? ''} is not allowed` });
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(hostname(safeOriginHost(origin)) ?? '')) {
      return send(res, 403, { error: 'forbidden_origin', message: `Origin ${origin} is not allowed` });
    }
    if (options.authToken && !bearerMatches(req.headers.authorization, options.authToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return send(res, 401, { error: 'unauthorized', message: 'Missing or wrong bearer token' });
    }

    const hasUolHeaders = [HEADER.tenant, HEADER.email, HEADER.token].some((h) => req.headers[h] !== undefined);
    if (mode === 'single-tenant' && hasUolHeaders) {
      return send(res, 400, {
        error: 'credentials_not_accepted',
        message: 'This server is configured for one UOL tenant; X-UOL-* headers are not accepted',
      });
    }
    if (mode === 'pass-through') {
      const problem = passThroughProblem(req);
      if (problem) return send(res, 401, { error: 'uol_credentials', message: problem });
    }

    await mcp(req, res);
  };
}

export async function startHttpServer(config: AppConfig, options: HttpOptions, deps: Dependencies = {}): Promise<Server> {
  const handler = createHttpHandler(config, options, deps);
  const server = createHttpServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      process.stderr.write(`uol-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });
  return server;
}

function passThroughProblem(req: IncomingMessage): string | undefined {
  const tenant = header(req, HEADER.tenant);
  if (!tenant) {
    return 'Send X-UOL-Tenant (e.g. "firma" or "demo"), X-UOL-Email and X-UOL-Token with every request';
  }
  try {
    const { isDemo } = resolveTenant(tenant);
    if (!isDemo && (!header(req, HEADER.email) || !header(req, HEADER.token))) {
      return 'X-UOL-Email and X-UOL-Token are required for this tenant';
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

function bearerMatches(authorization: string | undefined, expected: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  if (!match) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(match[1]!.trim()), digest(expected));
}

function hostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0];
}

function safeOriginHost(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
