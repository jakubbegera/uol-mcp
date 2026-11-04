import type { Page } from '../uol/client.js';

/** Largest page UOL accepts on its list endpoints. */
export const MAX_PER_PAGE = 250;

/**
 * Reads pages of a list endpoint until UOL stops sending a `next` link or
 * [maxPages] is reached. `truncated` tells the caller the cap cut it short.
 */
export async function fetchPages<T>(
  fetchPage: (page: number, perPage: number) => Promise<Page<T>>,
  maxPages: number,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = await fetchPage(page, MAX_PER_PAGE);
    rows.push(...(body.items ?? []));
    if (!body._meta?.pagination?.next) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
