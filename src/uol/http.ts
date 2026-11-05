import { randomBytes } from 'node:crypto';
import type { UolCredentials } from '../config.js';
import { UolApiError, errorFromResponse } from './errors.js';
import { RateLimiter, bucketFor } from './rate-limit.js';

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface HttpOptions {
  fetch?: typeof fetch;
  limiter?: RateLimiter;
  timeoutMs?: number;
  debug?: boolean;
}

export interface BinaryResponse {
  bytes: Buffer;
  contentType: string;
  /** Name advertised in `Content-Disposition`, already stripped of any path. */
  fileName?: string;
}

/**
 * Thin transport over the UOL REST API: Basic auth, rate limiting, timeouts,
 * error envelopes. Knows nothing about individual endpoints.
 */
export class UolHttp {
  readonly baseUrl: string;
  /** Tenant origin without `/api` — legacy document paths (`/customers/…`) hang off it. */
  readonly origin: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number;
  private readonly debug: boolean;

  constructor(credentials: UolCredentials, options: HttpOptions = {}) {
    this.baseUrl = credentials.baseUrl;
    this.origin = new URL(credentials.baseUrl).origin;
    this.authHeader = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.limiter = options.limiter ?? new RateLimiter();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.debug = options.debug ?? false;
  }

  /** GET a JSON resource; [path] is relative to the API root, e.g. `/v1/sales_invoices`. */
  async getJson<T>(path: string, query?: Query): Promise<T> {
    const response = await this.send(this.apiUrl(path, query), { accept: 'application/json' });
    return readJson<T>(response, path);
  }

  /**
   * POST / PATCH a JSON body. Booleans go out as strings — UOL requires that
   * for every boolean attribute in a write. Never retried: a timeout may still
   * have created the record, which is what idempotency keys are for.
   */
  async sendJson<T>(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<T> {
    const response = await this.send(this.apiUrl(path), {
      method,
      accept: 'application/json',
      contentType: 'application/json',
      body: JSON.stringify(stringifyBooleans(body)),
    });
    return readJson<T>(response, path);
  }

  /**
   * Any method with an optional JSON body; an empty answer (`204`) yields null.
   * Backs DELETE calls and the generic api_request tool.
   */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.send(this.apiUrl(path), {
      method,
      accept: 'application/json',
      ...(body === undefined
        ? {}
        : { contentType: 'application/json', body: JSON.stringify(stringifyBooleans(body)) }),
    });
    const text = await response.text();
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new UolApiError(`UOL returned a non-JSON body for ${path}.`, response.status, 'invalid_response');
    }
  }

  /** POST `multipart/form-data`; fetch sets the boundary. */
  async postForm<T>(path: string, form: FormData): Promise<T> {
    const response = await this.send(this.apiUrl(path), { method: 'POST', accept: 'application/json', body: form });
    return readJson<T>(response, path);
  }

  /**
   * Downloads a binary. [accept] must be a single media type: UOL picks the
   * representation by content negotiation and answers JSON when it sees a list.
   * URLs on a foreign origin (S3 pre-signed links) are fetched without our
   * Authorization header, which would otherwise clash with the AWS signature.
   */
  async getBinary(url: string, accept?: string): Promise<BinaryResponse> {
    const response = await this.send(url, { accept, auth: this.isOwnUrl(url) });
    return {
      bytes: await readCapped(response, MAX_DOWNLOAD_BYTES),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      fileName: fileNameFromContentDisposition(response.headers.get('content-disposition')),
    };
  }

  /** `HEAD` that returns the advertised file name, or undefined on any failure. */
  async peekFileName(url: string): Promise<string | undefined> {
    if (!this.isOwnUrl(url)) return undefined;
    try {
      const response = await this.send(url, { method: 'HEAD' });
      return fileNameFromContentDisposition(response.headers.get('content-disposition'));
    } catch {
      return undefined;
    }
  }

  /** Resolves the `file` field of an uploaded document to an absolute URL. */
  resolveFileUrl(file: string): string {
    return /^https?:\/\//i.test(file) ? file : `${this.origin}${file.startsWith('/') ? '' : '/'}${file}`;
  }

  apiUrl(path: string, query?: Query): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** The API path of [url] for error messages (`/v1/…`, no host, no query); foreign hosts stay unnamed. */
  private pathOf(url: string): string | undefined {
    if (!this.isOwnUrl(url)) return undefined;
    const path = new URL(url).pathname;
    const base = new URL(this.baseUrl).pathname;
    return path.startsWith(base) ? path.slice(base.length) || '/' : path;
  }

  private isOwnUrl(url: string): boolean {
    return new URL(url).origin === this.origin;
  }

  private async send(
    url: string,
    {
      accept,
      auth = true,
      method = 'GET',
      body,
      contentType,
    }: { accept?: string; auth?: boolean; method?: string; body?: string | FormData; contentType?: string },
  ): Promise<Response> {
    const parsed = new URL(url);
    const ownApi = parsed.origin === this.origin && parsed.pathname.startsWith('/api/');
    if (ownApi) await this.limiter.acquire(bucketFor(parsed.pathname.slice('/api'.length)));

    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = this.authHeader;
    if (accept) headers.Accept = accept;
    if (contentType) headers['Content-Type'] = contentType;

    const id = randomBytes(3).toString('hex');
    const started = Date.now();
    this.log(`[${id}] → ${method} ${redactUrl(parsed)}`);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`[${id}] ✗ ${reason}`);
      throw new UolApiError(`Could not reach UOL (${parsed.host}): ${reason}`, 0, 'network');
    }
    this.log(`[${id}] ← ${response.status} ${Date.now() - started} ms`);

    if (!response.ok) {
      throw errorFromResponse(response.status, await response.text().catch(() => ''), this.pathOf(url));
    }
    return response;
  }

  private log(line: string): void {
    if (this.debug) process.stderr.write(`uol-mcp ${line}\n`);
  }
}

async function readJson<T>(response: Response, path: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UolApiError(`UOL returned a non-JSON body for ${path}.`, response.status, 'invalid_response');
  }
}

/** `true` → `"true"` at any depth; everything else unchanged. */
export function stringifyBooleans(value: unknown): unknown {
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyBooleans);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stringifyBooleans(v)]));
  }
  return value;
}

/** Query strings of foreign URLs carry signatures; never write them to logs. */
function redactUrl(url: URL): string {
  return url.origin.endsWith('.uol.cz') ? `${url.pathname}${url.search}` : `${url.origin}${url.pathname}`;
}

/**
 * Handles both `filename="x.pdf"` and RFC 5987 `filename*=UTF-8''x%20y.pdf`
 * (preferred when both are present). UOL also sends raw UTF-8 bytes in the
 * plain form, which `fetch` exposes as Latin-1 text (`vystavenÃ¡`), so those are
 * re-decoded. Path segments are dropped so a name can never escape the
 * directory the caller writes into.
 */
export function fileNameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header)?.[1];
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  let name: string | undefined;
  if (extended) {
    const value = extended.trim().replace(/^"|"$/g, '');
    const encoded = value.includes("''") ? value.slice(value.indexOf("''") + 2) : value;
    try {
      name = decodeURIComponent(encoded);
    } catch {
      name = encoded;
    }
  } else if (plain) {
    name = latin1ToUtf8((plain[2] ?? plain[1] ?? '').trim());
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep the raw value
    }
  }
  const base = name?.normalize('NFC').split(/[\\/]/).pop()?.trim();
  return base ? base : undefined;
}

function latin1ToUtf8(value: string): string {
  if (!/[\u0080-ÿ]/.test(value) || /[^\u0000-ÿ]/.test(value)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('�') ? value : decoded;
}

/** Largest file a download reads into memory; UOL documents are a few MB at most. */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/** Reads the body, refusing anything past [limit] instead of buffering it all. */
async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const tooLarge = () =>
    new UolApiError(`The file is larger than ${limit / 1024 / 1024} MB; download it in UOL instead.`, 413, 'file_too_large');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > limit) {
      // Cancelling stops the transfer, so the rest is never downloaded.
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
}
