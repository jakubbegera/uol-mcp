import type { RawCompany } from '../uol/client.js';

/**
 * UOL keeps the company as a chain of dated revisions. The current one is
 * `status = valid` with no `valid_to`, latest `valid_from`; older revisions
 * often carry a stale VAT code. Falls back to the first row for tenants with
 * a single revision that doesn't follow the pattern.
 */
export function currentRevision(companies: RawCompany[]): RawCompany | undefined {
  const active = companies.filter((c) => c.status?.toLowerCase() === 'valid' && !c.valid_to);
  const sorted = [...active].sort((a, b) => (b.valid_from ?? '').localeCompare(a.valid_from ?? ''));
  return sorted[0] ?? companies[0];
}
