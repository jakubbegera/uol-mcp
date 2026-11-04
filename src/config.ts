import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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

export interface AppConfig {
  /** Absent when the server runs unconfigured — tools then answer with setup instructions. */
  credentials?: UolCredentials;
  /** Set when credentials were provided but are unusable (bad tenant, half-filled pair). */
  configError?: string;
  downloadDir: string;
  requestTimeoutMs: number;
  debug: boolean;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config: AppConfig = {
    downloadDir: env.UOL_DOWNLOAD_DIR?.trim() || defaultDownloadDir(),
    requestTimeoutMs: Number(env.UOL_TIMEOUT_MS) > 0 ? Number(env.UOL_TIMEOUT_MS) : 30_000,
    debug: env.UOL_DEBUG === '1' || env.UOL_DEBUG === 'true',
  };

  const tenant = env.UOL_TENANT?.trim();
  const email = env.UOL_EMAIL?.trim();
  const token = env.UOL_TOKEN?.trim();
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
