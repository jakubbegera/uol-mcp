// Pseudonymises natural persons in the recorded DEMO fixtures. The DEMO tenant
// is shared by every API user, so it holds contacts other people typed in;
// companies stay as they are (public register data), people do not.
//
// A contact counts as a person when its record says `taxable_person: false`,
// or — for contacts only referenced by id — when the id looks like
// `[title_]firstname_lastname` without a legal-form suffix.
//
// Usage: node scripts/scrub-fixtures.mjs <fixtures-dir>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: scrub-fixtures.mjs <fixtures-dir>');

const LEGAL_FORM = /(^|_)(sro|as|ks|vos|zs|se|ops|spol|holding|group|gmbh|ltd|inc)(_|$)/;
const PERSON_ID = /^((ing|mgr|bc|mudr|judr|phdr|rndr|doc|prof)_)?[a-z]+_[a-z]+$/;

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const texts = Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

const contacts = [];
const collect = (node) => {
  if (Array.isArray(node)) return node.forEach(collect);
  if (!node || typeof node !== 'object') return;
  if (typeof node.contact_id === 'string' && 'name' in node) contacts.push(node);
  Object.values(node).forEach(collect);
};
for (const text of Object.values(texts)) collect(JSON.parse(text));

const ids = new Set();
for (const text of Object.values(texts)) {
  for (const m of text.matchAll(/"contact_id": "([^"]+)"/g)) ids.add(m[1]);
  for (const m of text.matchAll(/\/contacts\/([^"/?]+)"/g)) ids.add(decodeURIComponent(m[1]));
}

const persons = new Set();
for (const c of contacts) if (c.taxable_person === false || c.business_entity === false) persons.add(c.contact_id);
for (const id of ids) if (PERSON_ID.test(id) && !LEGAL_FORM.test(id)) persons.add(id);

// Continue after pseudonyms already in the fixtures, so a re-run (or a newly
// recorded file) never hands an existing person_N to somebody else.
const taken = Object.values(texts).flatMap((t) => [...t.matchAll(/\bperson_(\d+)\b/g)].map((m) => Number(m[1])));
const offset = taken.length > 0 ? Math.max(...taken) : 0;
const ordered = [...persons].sort();
const idMap = new Map(ordered.map((id, i) => [id, `person_${offset + i + 1}`]));
const nameMap = new Map();
for (const c of contacts) {
  if (idMap.has(c.contact_id) && c.name) nameMap.set(c.name, `Person ${idMap.get(c.contact_id).slice(7)}`);
}

const scrubContact = (node) => {
  if (Array.isArray(node)) return node.forEach(scrubContact);
  if (!node || typeof node !== 'object') return;
  if (typeof node.contact_id === 'string' && idMap.has(node.contact_id) && 'name' in node) {
    for (const key of ['company_number', 'vatin', 'tin', 'sipo_number', 'note', 'external_id']) {
      if (node[key] != null) node[key] = null;
    }
    if (node.specific_symbol != null) node.specific_symbol = null;
    // The address slug spells out the real street, so it goes too.
    (node.addresses ?? []).forEach((a, i) => {
      Object.assign(a, {
        address_id: `${idMap.get(node.contact_id)}_address_${i + 1}`,
        street: 'Testovací 1',
        building_number: null,
        city: 'Testov',
        postal_code: '000 00',
        email: null,
        phone: null,
        mobile_phone: null,
        url: null,
      });
    });
    for (const b of node.bank_accounts ?? []) {
      Object.assign(b, { bank_account: '0000000000/0000', iban: 'CZ0000000000000000000000', name: null });
    }
  }
  Object.values(node).forEach(scrubContact);
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [file, text] of Object.entries(texts)) {
  const body = JSON.parse(text);
  scrubContact(body);
  let out = JSON.stringify(body, null, 2);
  for (const [id, alias] of idMap) out = out.replace(new RegExp(`(?<=["/])${escape(id)}(?=")`, 'g'), alias);
  for (const [name, alias] of nameMap) out = out.replaceAll(name, alias);
  writeFileSync(join(dir, file), `${out}\n`);
}

console.log(`scrubbed ${idMap.size} person contact(s): ${[...idMap.values()].join(', ') || 'none'}`);
