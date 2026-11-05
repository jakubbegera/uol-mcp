import { describe, expect, it } from 'vitest';
import { ContactNames } from '../src/domain/contact-names.js';
import type { RawContact, UolClient } from '../src/uol/client.js';

/** A client whose contact list holds `listed` contacts, served `per_page` at a time. */
function stubClient(listed: number) {
  const contacts = Array.from({ length: listed }, (_, i): RawContact => ({ contact_id: `c${i}`, name: `Contact ${i}` }));
  const calls = { list: [] as Record<string, unknown>[], single: [] as string[] };
  const client = {
    contacts: async (query: Record<string, unknown>) => {
      calls.list.push(query);
      const perPage = Number(query.per_page);
      const page = Number(query.page);
      const next = page * perPage < contacts.length ? { next: `https://x.uol.cz/api/v1/contacts?page=${page + 1}` } : {};
      return { items: contacts.slice((page - 1) * perPage, page * perPage), _meta: { pagination: next } };
    },
    contact: async (id: string) => {
      calls.single.push(id);
      if (!id.startsWith('c')) throw new Error('not found');
      return { name: `Single ${id}` };
    },
  };
  return { client: client as unknown as UolClient, calls };
}

describe('ContactNames', () => {
  it('reads many names from the contact list and looks up only the leftovers', async () => {
    // arrange
    const { client, calls } = stubClient(120);
    const names = new ContactNames(client);
    const ids = [...Array.from({ length: 120 }, (_, i) => `c${i}`), 'gone', null];

    // act
    const result = await names.resolve(ids);

    // assert
    expect(calls.list).toEqual([
      { hidden: 'all', per_page: 100, page: 1 },
      { hidden: 'all', per_page: 100, page: 2 },
    ]);
    expect(calls.single).toEqual(['gone']);
    expect(result.get('c0')).toBe('Contact 0');
    expect(result.get('c119')).toBe('Contact 119');
    expect(result.get('gone')).toBeNull();
    expect(result.size).toBe(121);
  });

  it('looks a few names up one by one without reading the list', async () => {
    // arrange
    const { client, calls } = stubClient(120);
    const names = new ContactNames(client);

    // act
    const result = await names.resolve(['c1', 'c2']);

    // assert
    expect(calls.list).toEqual([]);
    expect(calls.single).toEqual(['c1', 'c2']);
    expect(result.get('c1')).toBe('Single c1');
  });

  it('serves names from the cache on the next call', async () => {
    // arrange
    const { client, calls } = stubClient(30);
    const names = new ContactNames(client);
    await names.resolve(Array.from({ length: 30 }, (_, i) => `c${i}`));
    calls.list.length = 0;

    // act
    const result = await names.resolve(['c5', 'c25']);

    // assert
    expect(calls.list).toEqual([]);
    expect(calls.single).toEqual([]);
    expect(result.get('c25')).toBe('Contact 25');
  });
});
