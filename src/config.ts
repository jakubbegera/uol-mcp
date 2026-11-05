import { existsSync, readFileSync, statSync } from 'node:fs';
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

export const TOOLSETS = ['core', 'insights', 'ledger', 'banking', 'warehouse'] as const;
export type Toolset = (typeof TOOLSETS)[number];
/** What most users need; the rest is opt-in to keep the tool list short for the model. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = ['core', 'insights'];

/** `read` — no writes; `write` — create / update / upload; `full` — adds destructive tools. */
export const ACCESS_LEVELS = ['read', 'write', 'full'] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

/** Whether [granted] covers [needed]: read < write < full. */
export function allows(granted: Access, needed: Access): boolean {
  return ACCESS_LEVELS.indexOf(granted) >= ACCESS_LEVELS.indexOf(needed);
}

/** An account's own access level, falling back to UOL_ACCESS. */
export function accessOf(config: AppConfig, account?: Account): Access {
  return account?.access ?? config.access ?? 'read';
}

/** The highest level any account has: decides which tools are registered at all. */
export function highestAccess(config: AppConfig): Access {
  const levels = config.accounts?.length ? config.accounts.map((a) => accessOf(config, a)) : [accessOf(config)];
  return levels.reduce((best, level) => (allows(level, best) ? level : best), 'read' as Access);
}

function parseAccess(raw: string | undefined, name: string): Access | undefined {
  if (raw === undefined) return undefined;
  const level = raw.toLowerCase();
  if (!(ACCESS_LEVELS as readonly string[]).includes(level)) {
    throw new ConfigError(`${name} must be one of ${ACCESS_LEVELS.join(', ')}, got "${raw}"`);
  }
  return level as Access;
}

/** One named UOL tenant from UOL_PROFILES_FILE. */
export interface Account {
  name: string;
  label?: string;
  credentials: UolCredentials;
  /** Overrides UOL_ACCESS for this account; a level above it still needs the tools registered. */
  access?: Access;
}

export interface AppConfig {
  /**
   * Credentials of the single tenant, or of the default account when
   * [accounts] is set. Absent when the server runs unconfigured — tools then
   * answer with setup instructions.
   */
  credentials?: UolCredentials;
  /** Several tenants (UOL_PROFILES_FILE); tools then take an `account` argument. */
  accounts?: Account[];
  defaultAccount?: string;
  /** Set when credentials were provided but are unusable (bad tenant, half-filled pair). */
  configError?: string;
  /** Tool groups to register; [DEFAULT_TOOLSETS] when unset. */
  toolsets?: ReadonlySet<Toolset>;
  /** Which write tools exist at all; `read` when unset. */
  access?: Access;
  /** Directories upload_document may read files from. */
  uploadDirs?: string[];
  /** True when UOL_UPLOAD_DIRS was set; the HTTP server allows file_path uploads only then. */
  explicitUploadDirs?: boolean;
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

/** `UOL_TOOLSETS=core,ledger` / `all`; unset means [DEFAULT_TOOLSETS]; unknown names are reported, not fatal. */
export function parseToolsets(raw: string | undefined): { toolsets: Set<Toolset>; unknown: string[] } {
  const names = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return { toolsets: new Set(DEFAULT_TOOLSETS), unknown: [] };
  if (names.includes('all')) return { toolsets: new Set(TOOLSETS), unknown: [] };
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
export function resolveTenant(input: string, name = 'UOL_TENANT'): { baseUrl: string; isDemo: boolean } {
  const raw = input.trim();
  if (raw === '') throw new ConfigError(`${name} is empty`);
  if (raw.toLowerCase() === 'demo') return { baseUrl: DEMO.baseUrl, isDemo: true };

  let host: string;
  if (/^[a-z]+:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ConfigError(`${name} is not a valid URL: ${raw}`);
    }
    if (url.protocol !== 'https:') throw new ConfigError(`${name} must use https: ${raw}`);
    host = url.hostname.toLowerCase();
  } else {
    const prefix = raw.toLowerCase().replace(/\.uol\.cz$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(prefix)) {
      throw new ConfigError(`${name} has unexpected characters: ${raw}`);
    }
    host = prefix.includes('.') ? `${prefix}.uol.cz` : `${prefix}.ucetnictvi.uol.cz`;
  }

  if (!host.endsWith('.uol.cz')) {
    throw new ConfigError(`${name} must point to a *.uol.cz host, got ${host}`);
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
    explicitUploadDirs: Boolean(uploadDirs && uploadDirs.length > 0),
    auditLog: value(env.UOL_AUDIT_LOG),
    warnings,
    downloadDir: value(env.UOL_DOWNLOAD_DIR) ?? defaultDownloadDir(),
    requestTimeoutMs: Number(env.UOL_TIMEOUT_MS) > 0 ? Number(env.UOL_TIMEOUT_MS) : 30_000,
    debug: env.UOL_DEBUG === '1' || env.UOL_DEBUG === 'true',
  };

  const tenant = value(env.UOL_TENANT);
  const email = value(env.UOL_EMAIL);
  const token = value(env.UOL_TOKEN);
  const profilesFile = value(env.UOL_PROFILES_FILE);
  const accountList = value(env.UOL_ACCOUNTS);

  try {
    if (profilesFile || accountList) {
      if (profilesFile && accountList) throw new ConfigError('Set either UOL_ACCOUNTS or UOL_PROFILES_FILE, not both');
      const source = accountList ? 'UOL_ACCOUNTS' : 'UOL_PROFILES_FILE';
      if (tenant || email || token) warnings.push(`${source} is set; ignoring UOL_TENANT / UOL_EMAIL / UOL_TOKEN`);
      const profiles = accountList ? accountsFromEnv(accountList, env) : loadProfiles(profilesFile!, env, warnings);
      config.accounts = profiles.accounts;
      config.defaultAccount = profiles.defaultAccount;
      config.credentials = profiles.accounts.find((a) => a.name === profiles.defaultAccount)!.credentials;
      return config;
    }
    if (!tenant && !email && !token) return config;
    config.credentials = credentialsFor(tenant, email, token, 'UOL_TENANT', 'UOL_EMAIL and UOL_TOKEN');
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    config.configError = error.message;
  }
  return config;
}

function credentialsFor(
  tenant: string | undefined,
  email: string | undefined,
  token: string | undefined,
  tenantName: string,
  pairName: string,
): UolCredentials {
  if (!tenant) throw new ConfigError(`${tenantName} is missing`);
  const { baseUrl, isDemo } = resolveTenant(tenant, tenantName);
  if (isDemo && !email && !token) return { baseUrl, email: DEMO.email, token: DEMO.token, isDemo };
  if (!email || !token) throw new ConfigError(`${pairName} must both be set`);
  return { baseUrl, email, token, isDemo };
}

const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * Several tenants straight from the environment — for hosts whose config is
 * an env block (Claude Desktop), and so `op run` can resolve each token from
 * an `op://` reference:
 *
 * ```
 * UOL_ACCOUNTS=firma,novak          (first one is the default, or UOL_DEFAULT_ACCOUNT)
 * UOL_ACCOUNT_FIRMA_TENANT=firma
 * UOL_ACCOUNT_FIRMA_EMAIL=ja@firma.cz
 * UOL_ACCOUNT_FIRMA_TOKEN=op://…
 * UOL_ACCOUNT_FIRMA_LABEL=Firma s.r.o.   (optional)
 * ```
 *
 * The variable prefix is the account name upper-cased, with `-` as `_`.
 */
export function accountsFromEnv(list: string, env: NodeJS.ProcessEnv): { accounts: Account[]; defaultAccount: string } {
  const names = list
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) throw new ConfigError('UOL_ACCOUNTS lists no account');
  const accounts = names.map((name) => {
    if (!ACCOUNT_NAME.test(name)) {
      throw new ConfigError(`UOL_ACCOUNTS: account name "${name}" must be lowercase letters, digits, - or _`);
    }
    const prefix = `UOL_ACCOUNT_${name.toUpperCase().replace(/-/g, '_')}_`;
    const credentials = credentialsFor(
      value(env[`${prefix}TENANT`]),
      value(env[`${prefix}EMAIL`]),
      value(env[`${prefix}TOKEN`]),
      `${prefix}TENANT`,
      `${prefix}EMAIL and ${prefix}TOKEN`,
    );
    return {
      name,
      label: value(env[`${prefix}LABEL`]),
      credentials,
      access: parseAccess(value(env[`${prefix}ACCESS`]), `${prefix}ACCESS`),
    };
  });
  const defaultAccount = value(env.UOL_DEFAULT_ACCOUNT)?.toLowerCase() ?? names[0]!;
  if (!names.includes(defaultAccount)) {
    throw new ConfigError(`UOL_DEFAULT_ACCOUNT "${defaultAccount}" is not listed in UOL_ACCOUNTS`);
  }
  return { accounts, defaultAccount };
}

/**
 * Reads UOL_PROFILES_FILE — several tenants for accountants:
 *
 * ```json
 * { "default": "firma",
 *   "accounts": {
 *     "firma":  { "tenant": "firma", "email": "ja@firma.cz", "token_env": "UOL_TOKEN_FIRMA" },
 *     "novak":  { "tenant": "novak", "email": "ja@firma.cz", "token": "…", "label": "Novák s.r.o." },
 *     "demo":   { "tenant": "demo" } } }
 * ```
 *
 * `token_env` names an environment variable, so tokens don't have to live in
 * the file. A file with inline tokens that others can read is reported.
 */
export function loadProfiles(
  path: string,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): { accounts: Account[]; defaultAccount: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // JSON.parse quotes the text around the error, which may be a token, so only the kind of failure is reported.
    const reason = error instanceof SyntaxError ? 'is not valid JSON' : `can't be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
    throw new ConfigError(`UOL_PROFILES_FILE ${path} ${reason}`);
  }
  const root = (parsed ?? {}) as { default?: unknown; accounts?: Record<string, Record<string, unknown>> };
  const entries = Object.entries(root.accounts ?? {});
  if (entries.length === 0) throw new ConfigError(`UOL_PROFILES_FILE ${path} has no "accounts"`);

  let inlineTokens = false;
  const accounts = entries.map(([name, raw]) => {
    if (!ACCOUNT_NAME.test(name)) {
      throw new ConfigError(`UOL_PROFILES_FILE: account name "${name}" must be lowercase letters, digits, - or _`);
    }
    const text = (key: string) => (typeof raw[key] === 'string' ? value(raw[key] as string) : undefined);
    const tokenEnv = text('token_env');
    if (text('token')) inlineTokens = true;
    const token = text('token') ?? (tokenEnv ? value(env[tokenEnv]) : undefined);
    if (tokenEnv && !token) throw new ConfigError(`UOL_PROFILES_FILE: account "${name}" reads its token from ${tokenEnv}, which is not set`);
    const credentials = credentialsFor(text('tenant'), text('email'), token, `account "${name}": tenant`, `account "${name}": email and token`);
    return { name, label: text('label'), credentials, access: parseAccess(text('access'), `account "${name}": access`) };
  });

  const defaultAccount = typeof root.default === 'string' ? root.default : accounts[0]!.name;
  if (!accounts.some((a) => a.name === defaultAccount)) {
    throw new ConfigError(`UOL_PROFILES_FILE: default account "${defaultAccount}" is not among the accounts`);
  }
  if (inlineTokens && process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
    warnings.push(`${path} contains API tokens and is readable by other users; run chmod 600 on it or use token_env`);
  }
  return { accounts, defaultAccount };
}

export const SETUP_HINT =
  'Set UOL_TENANT (e.g. "firma" for https://firma.ucetnictvi.uol.cz, or "demo"), ' +
  'UOL_EMAIL and UOL_TOKEN, or UOL_ACCOUNTS with UOL_ACCOUNT_<NAME>_TENANT / _EMAIL / _TOKEN ' +
  'for several companies (create the token on your tenant at /api_tokens). ' +
  'The UOL user needs the "REST API" permission.';
