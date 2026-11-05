import type { Page, RawContact, UolClient } from '../uol/client.js';

interface Entry {
  name: string | null;
  at: number;
}

/** Contacts per page when names are read from the contact list. */
const LIST_PAGE_SIZE = 100;

/**
 * Contact id → display name. Invoices and receivables reference counterparties
 * only by slug (`skoda_auto_as`), so lists resolve names here. A few names are
 * looked up one by one; when more are missing than that, the contact list is
 * read first (100 names per request, hidden contacts included), which keeps a
 * page of 100 invoices with dozens of suppliers inside the rate limit. Ids the
 * list doesn't cover fall back to single lookups, still capped per call; ids
 * beyond the cap keep a null name and the slug is still returned.
 */
export class ContactNames {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly client: UolClient,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxListPages = 10,
  ) {}

  remember(contact: RawContact): void {
    if (contact.contact_id) this.cache.set(contact.contact_id, { name: contact.name ?? null, at: this.now() });
  }

  async resolve(ids: Iterable<string | null>, maxLookups = 15): Promise<Map<string, string | null>> {
    const wanted = [...new Set(ids)].filter((id): id is string => Boolean(id));
    const result = new Map<string, string | null>();
    const fromCache = () => {
      const missing: string[] = [];
      for (const id of wanted) {
        const hit = this.cache.get(id);
        if (hit && this.now() - hit.at < this.ttlMs) result.set(id, hit.name);
        else missing.push(id);
      }
      return missing;
    };

    let missing = fromCache();
    if (missing.length > maxLookups) {
      await this.readList(new Set(missing));
      missing = fromCache();
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

  /** Pages through the contact list until every wanted id is cached (or the page cap is hit). */
  private async readList(wanted: Set<string>): Promise<void> {
    for (let page = 1; page <= this.maxListPages && wanted.size > 0; page++) {
      let body: Page<RawContact>;
      try {
        body = await this.client.contacts({ hidden: 'all', per_page: LIST_PAGE_SIZE, page });
      } catch {
        return; // single lookups still cover what they can
      }
      for (const contact of body.items ?? []) {
        this.remember(contact);
        if (contact.contact_id) wanted.delete(contact.contact_id);
      }
      if (!body._meta?.pagination?.next) return;
    }
  }
}
