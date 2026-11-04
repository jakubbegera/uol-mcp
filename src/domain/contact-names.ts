import type { RawContact, UolClient } from '../uol/client.js';

interface Entry {
  name: string | null;
  at: number;
}

/**
 * Contact id → display name. Invoices and receivables reference counterparties
 * only by slug (`skoda_auto_as`), so lists resolve names here. Lookups are
 * capped per call to stay inside the rate limit; ids beyond the cap keep a
 * null name and the slug is still returned.
 */
export class ContactNames {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly client: UolClient,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  remember(contact: RawContact): void {
    if (contact.contact_id) this.cache.set(contact.contact_id, { name: contact.name ?? null, at: this.now() });
  }

  async resolve(ids: Iterable<string | null>, maxLookups = 15): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      if (!id) continue;
      const hit = this.cache.get(id);
      if (hit && this.now() - hit.at < this.ttlMs) result.set(id, hit.name);
      else missing.push(id);
    }

    await Promise.all(
      missing.slice(0, maxLookups).map(async (id) => {
        try {
          const contact = await this.client.contact(id);
          this.remember({ ...contact, contact_id: id });
          result.set(id, contact.name ?? null);
        } catch {
          result.set(id, null);
        }
      }),
    );
    return result;
  }
}
