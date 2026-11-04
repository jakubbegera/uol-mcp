/**
 * Helpers that turn UOL's raw JSON into the shapes the tools return. UOL
 * sends amounts as strings, references as nested objects and pagination as
 * links, and the spec documents almost none of it — everything here is
 * lenient and never throws on a missing field.
 */

export interface Href {
  _meta?: { href?: string | null } | null;
}

export interface PaginationMeta {
  _meta?: {
    pagination?: { first?: string; last?: string; next?: string; prev?: string } | null;
  } | null;
}

/** `"1210.0"` / `1210` → `1210`; anything unparsable → `null`. */
export function amount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/** Rounds to cents so sums of string amounts don't print float noise. */
export function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function str(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  return value === '' ? null : value;
}

/** Last path segment of `{_meta: {href}}` — how UOL references contacts. */
export function hrefId(ref: Href | null | undefined): string | null {
  const href = ref?._meta?.href;
  if (!href) return null;
  const id = href.split('/').pop();
  return id ? decodeURIComponent(id) : null;
}

/** `{currency_id: "CZK"}` style references. */
export function refId(ref: unknown, key: string): string | null {
  if (!ref || typeof ref !== 'object') return null;
  return str((ref as Record<string, unknown>)[key]);
}

export interface PageInfo {
  page: number;
  per_page: number;
  has_more: boolean;
  /** From the `last` link; null when UOL omits it. */
  total_pages: number | null;
}

export function pageInfo(body: PaginationMeta, page: number, perPage: number): PageInfo {
  const pagination = body._meta?.pagination;
  const last = pagination?.last ? Number(new URL(pagination.last).searchParams.get('page')) : NaN;
  return {
    page,
    per_page: perPage,
    has_more: Boolean(pagination?.next),
    total_pages: Number.isFinite(last) && last > 0 ? last : null,
  };
}

/**
 * Invoice `status`. Note the trap: on invoices `valid` means *draft*, while on
 * accounting records the same word means *posted*.
 */
export function invoiceStatus(raw: unknown): 'draft' | 'issued' | 'cancelled' | 'unknown' {
  switch (raw) {
    case 'valid':
      return 'draft';
    case 'confirmed':
      return 'issued';
    case 'invalid':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/** `invoice_type` on `/v1/receivables` (sales invoices only). */
export function receivableKind(raw: unknown): 'standard' | 'proforma' | 'corrective' | 'unknown' {
  switch (raw) {
    case 'N':
      return 'standard';
    case 'Z':
      return 'proforma';
    case 'D':
      return 'corrective';
    default:
      return 'unknown';
  }
}

/** `vat_payer_code` on `/v1/my_companies` (undocumented): `M` monthly, `K` quarterly. */
export function vatPeriod(raw: unknown): 'monthly' | 'quarterly' | 'not_vat_payer' {
  if (raw === 'M') return 'monthly';
  if (raw === 'K') return 'quarterly';
  return 'not_vat_payer';
}

/** ISO date (`yyyy-mm-dd`) of [date] in Prague, which is what UOL's date filters mean. */
export function pragueDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(date);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/** Drops bookkeeping noise (`_meta`, audit fields) from a raw record for generic listings. */
export function stripNoise(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (NOISE_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

const NOISE_KEYS = new Set(['_meta', 'creator', 'modifier', 'created_at', 'updated_at', 'logo', 'auth_token_stub']);
