import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Public DEMO tenant published in the UOL OpenAPI spec. */
export const DEMO = {
  baseUrl: 'https://test.demo.uol.cz/api',
  email: 'demo@ucetnictvi-on-line.cz',
  token: '3R1Cc_wzcSuq02Wsh1-uww',
} as const;

export interface UolCredentials {
  /** API root including `/api`, e.g. `https://firma.ucetnictvi.uol.cz/api`. */
  baseUrl: string;
  email: string;
  token: string;
  isDemo: boolean;
}

export const TOOLSETS = ['core', 'insights'] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** `read` — no writes; `write` — create / update / upload; `full` — reserved for destructive tools. */
export const ACCESS_LEVELS = ['read', 'write', 'full'] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export interface AppConfig {
  /** Absent when the server runs unconfigured — tools then answer with setup instructions. */
  credentials?: UolCredentials;
  /** Set when credentials were provided but are unusable (bad tenant, half-filled pair). */
  configError?: string;
  /** Tool groups to register; every group when unset. */
  toolsets?: ReadonlySet<Toolset>;
  /** Which write tools exist at all; `read` when unset. */
  access?: Access;
  /** Directories upload_document may read files from. */
  uploadDirs?: string[];
  /** JSONL file every write is appended to. */
  auditLog?: string;
  /**
   * Return exported / downloaded files inside the tool result instead of only
   * saving them — for the HTTP transport, whose clients can't reach the server's disk.
   */
  embedFiles?: boolean;
  /** Non-fatal configuration problems, printed at startup. */
  warnings?: string[];
  downloadDir: string;
  requestTimeoutMs: number;
  debug: boolean;
}

export function defaultUploadDirs(): string[] {
  return ['Downloads', 'Desktop', 'Documents'].map((d) => join(homedir(), d));
}

/** `UOL_TOOLSETS=core,insights` / `all`; unknown names are reported, not fatal. */
export function parseToolsets(raw: string | undefined): { toolsets: Set<Toolset>; unknown: string[] } {
  const names = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0 || names.includes('all')) return { toolsets: new Set(TOOLSETS), unknown: [] };
  const known = names.filter((n): n is Toolset => (TOOLSETS as readonly string[]).includes(n));
  return { toolsets: new Set(known), unknown: names.filter((n) => !known.includes(n as Toolset)) };
}

export class ConfigError extends Error {}

/**
 * Turns whatever the user typed as a tenant into the API root.
 *
 * Accepted forms:
 *  - `demo` → the public DEMO tenant
 *  - `firma` → `https://firma.ucetnictvi.uol.cz/api` (production is the common case)
 *  - `firma.ucetnictvi`, `firma.sandbox` → `https://<prefix>.uol.cz/api`
 *  - a full URL with or without `/api` or `/api/v1`
 *
 * Only `https://*.uol.cz` hosts are allowed, so a typo or a hostile config can't
 * make the server send the user's Basic-auth credentials somewhere else.
 */
export function resolveTenant(input: string): { baseUrl: string; isDemo: boolean } {
  const raw = input.trim();
  if (raw === '') throw new ConfigError('UOL_TENANT is empty');
  if (raw.toLowerCase() === 'demo') return { baseUrl: DEMO.baseUrl, isDemo: true };

  let host: string;
  if (/^[a-z]+:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ConfigError(`UOL_TENANT is not a valid URL: ${raw}`);
    }
    if (url.protocol !== 'https:') throw new ConfigError(`UOL_TENANT must use https: ${raw}`);
    host = url.hostname.toLowerCase();
  } else {
    const prefix = raw.toLowerCase().replace(/\.uol\.cz$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(prefix)) {
      throw new ConfigError(`UOL_TENANT has unexpected characters: ${raw}`);
    }
    host = prefix.includes('.') ? `${prefix}.uol.cz` : `${prefix}.ucetnictvi.uol.cz`;
  }

  if (!host.endsWith('.uol.cz')) {
    throw new ConfigError(`UOL_TENANT must point to a *.uol.cz host, got ${host}`);
  }
  const baseUrl = `https://${host}/api`;
  return { baseUrl, isDemo: baseUrl === DEMO.baseUrl };
}

function defaultDownloadDir(): string {
  const downloads = join(homedir(), 'Downloads');
  return existsSync(downloads) ? join(downloads, 'uol-mcp') : join(tmpdir(), 'uol-mcp');
}

/**
 * Trimmed value, or undefined when blank. Hosts that template the env (MCPB's
 * `${user_config.email}`) may pass the placeholder through when the user
 * leaves an optional field empty, so an unexpanded placeholder counts as blank.
 */
function value(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v && !/^\$\{[^}]*\}$/.test(v) ? v : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const { toolsets, unknown } = parseToolsets(value(env.UOL_TOOLSETS));
  const warnings =
    unknown.length > 0 ? [`ignoring unknown UOL_TOOLSETS entries: ${unknown.join(', ')} (known: ${TOOLSETS.join(', ')}, all)`] : [];
  const rawAccess = value(env.UOL_ACCESS)?.toLowerCase() ?? 'read';
  const access = (ACCESS_LEVELS as readonly string[]).includes(rawAccess) ? (rawAccess as Access) : 'read';
  if (access !== rawAccess) warnings.push(`unknown UOL_ACCESS "${rawAccess}", using read (known: ${ACCESS_LEVELS.join(', ')})`);
  const uploadDirs = value(env.UOL_UPLOAD_DIRS)
    ?.split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean);

  const config: AppConfig = {
    toolsets,
    access,
    uploadDirs: uploadDirs && uploadDirs.length > 0 ? uploadDirs : defaultUploadDirs(),
    auditLog: value(env.UOL_AUDIT_LOG),
    warnings,
    downloadDir: value(env.UOL_DOWNLOAD_DIR) ?? defaultDownloadDir(),
    requestTimeoutMs: Number(env.UOL_TIMEOUT_MS) > 0 ? Number(env.UOL_TIMEOUT_MS) : 30_000,
    debug: env.UOL_DEBUG === '1' || env.UOL_DEBUG === 'true',
  };

  const tenant = value(env.UOL_TENANT);
  const email = value(env.UOL_EMAIL);
  const token = value(env.UOL_TOKEN);
  if (!tenant && !email && !token) return config;

  try {
    if (!tenant) throw new ConfigError('UOL_TENANT is missing');
    const { baseUrl, isDemo } = resolveTenant(tenant);
    if (isDemo && !email && !token) {
      config.credentials = { baseUrl, email: DEMO.email, token: DEMO.token, isDemo };
    } else if (!email || !token) {
      throw new ConfigError('UOL_EMAIL and UOL_TOKEN must both be set');
    } else {
      config.credentials = { baseUrl, email, token, isDemo };
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    config.configError = error.message;
  }
  return config;
}

export const SETUP_HINT =
  'Set UOL_TENANT (e.g. "firma" for https://firma.ucetnictvi.uol.cz, or "demo"), ' +
  'UOL_EMAIL and UOL_TOKEN (create the token on your tenant at /api_tokens). ' +
  'The UOL user needs the "REST API" permission.';
