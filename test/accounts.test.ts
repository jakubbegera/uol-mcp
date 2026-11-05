import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { connect, fakeUolFetch } from './support/fake-uol.js';

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

function profiles(content: unknown, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'uol-mcp-profiles-'));
  const file = join(dir, 'profiles.json');
  writeFileSync(file, JSON.stringify(content));
  chmodSync(file, mode);
  return file;
}

const TWO_ACCOUNTS = {
  default: 'demo',
  accounts: {
    demo: { tenant: 'demo', label: 'Veřejné DEMO' },
    firma: { tenant: 'firma', email: 'ja@firma.cz', token_env: 'UOL_TOKEN_FIRMA' },
  },
};

describe('UOL_PROFILES_FILE', () => {
  it('reports invalid JSON without quoting the file, which may hold a token', () => {
    // arrange
    const dir = mkdtempSync(join(tmpdir(), 'uol-mcp-profiles-'));
    const file = join(dir, 'profiles.json');
    writeFileSync(file, '{"accounts":{"a":{"tenant":"firma","email":"x@y.cz","token":SECRETTOKEN}}}');

    // act
    const config = loadConfig({ UOL_PROFILES_FILE: file });

    // assert
    expect(config.configError).toMatch(/is not valid JSON/);
    expect(config.configError).not.toMatch(/SECRET/);
  });

  it('loads accounts, resolves token_env and picks the default', () => {
    // act
    const config = loadConfig({ UOL_PROFILES_FILE: profiles(TWO_ACCOUNTS), UOL_TOKEN_FIRMA: 'secret' });

    // assert
    expect(config.configError).toBeUndefined();
    expect(config.defaultAccount).toBe('demo');
    expect(config.accounts?.map((a) => [a.name, a.credentials.baseUrl, a.credentials.token])).toEqual([
      ['demo', 'https://test.demo.uol.cz/api', '3R1Cc_wzcSuq02Wsh1-uww'],
      ['firma', 'https://firma.ucetnictvi.uol.cz/api', 'secret'],
    ]);
    expect(config.credentials?.isDemo).toBe(true);
  });

  it.each([
    [{ accounts: {} }, /no "accounts"/],
    [{ accounts: { 'Bad Name': { tenant: 'demo' } } }, /lowercase/],
    [{ accounts: { a: { tenant: 'firma', email: 'x@y.cz' } } }, /email and token must both be set/],
    [{ accounts: { a: { tenant: 'firma', email: 'x@y.cz', token_env: 'NOPE' } } }, /NOPE, which is not set/],
    [{ default: 'b', accounts: { a: { tenant: 'demo' } } }, /default account "b"/],
    [{ accounts: { a: { tenant: 'https://evil.example' } } }, /\*\.uol\.cz/],
  ])('reports %j', (content, message) => {
    expect(loadConfig({ UOL_PROFILES_FILE: profiles(content) }).configError).toMatch(message);
  });

  it('warns about inline tokens in a file others can read', () => {
    // arrange
    const file = profiles({ accounts: { a: { tenant: 'firma', email: 'x@y.cz', token: 't' } } }, 0o644);

    // act
    const config = loadConfig({ UOL_PROFILES_FILE: file });

    // assert
    expect(config.warnings?.some((w) => /chmod 600/.test(w))).toBe(true);
  });
});

describe('UOL_ACCOUNTS', () => {
  it('reads every account from prefixed variables, first one as default', () => {
    // act
    const config = loadConfig({
      UOL_ACCOUNTS: 'firma, klient-b',
      UOL_ACCOUNT_FIRMA_TENANT: 'firma',
      UOL_ACCOUNT_FIRMA_EMAIL: 'ja@firma.cz',
      UOL_ACCOUNT_FIRMA_TOKEN: 't1',
      UOL_ACCOUNT_KLIENT_B_TENANT: 'demo',
      UOL_ACCOUNT_KLIENT_B_LABEL: 'Klient B',
    });

    // assert
    expect(config.configError).toBeUndefined();
    expect(config.defaultAccount).toBe('firma');
    expect(config.accounts?.map((a) => [a.name, a.label, a.credentials.baseUrl, a.credentials.token])).toEqual([
      ['firma', undefined, 'https://firma.ucetnictvi.uol.cz/api', 't1'],
      ['klient-b', 'Klient B', 'https://test.demo.uol.cz/api', '3R1Cc_wzcSuq02Wsh1-uww'],
    ]);
  });

  it.each([
    [{ UOL_ACCOUNTS: 'a', UOL_ACCOUNT_A_TENANT: 'firma', UOL_ACCOUNT_A_EMAIL: 'x@y.cz' }, /UOL_ACCOUNT_A_EMAIL and UOL_ACCOUNT_A_TOKEN/],
    [{ UOL_ACCOUNTS: 'a' }, /UOL_ACCOUNT_A_TENANT is missing/],
    [{ UOL_ACCOUNTS: 'a', UOL_ACCOUNT_A_TENANT: '<tenant-a>' }, /UOL_ACCOUNT_A_TENANT has unexpected characters/],
    [{ UOL_ACCOUNTS: 'a', UOL_ACCOUNT_A_TENANT: 'demo', UOL_DEFAULT_ACCOUNT: 'b' }, /not listed/],
    [{ UOL_ACCOUNTS: 'a', UOL_ACCOUNT_A_TENANT: 'demo', UOL_PROFILES_FILE: '/x.json' }, /not both/],
  ])('reports %j', (env, message) => {
    expect(loadConfig(env).configError).toMatch(message);
  });

  it('honours UOL_DEFAULT_ACCOUNT', () => {
    expect(
      loadConfig({ UOL_ACCOUNTS: 'a,b', UOL_ACCOUNT_A_TENANT: 'demo', UOL_ACCOUNT_B_TENANT: 'demo', UOL_DEFAULT_ACCOUNT: 'B' })
        .defaultAccount,
    ).toBe('b');
  });
});

describe('multi-account tools', () => {
  it('adds list_accounts and an account argument, and routes calls to that tenant', async () => {
    // arrange
    const { fetch, requests } = fakeUolFetch();
    const config = loadConfig({ UOL_PROFILES_FILE: profiles(TWO_ACCOUNTS), UOL_TOKEN_FIRMA: 'secret', UOL_DOWNLOAD_DIR: tmpdir() });
    client = await connect(config, fetch);

    // act
    const { tools } = await client.listTools();
    const listed = await client.callTool({ name: 'list_accounts', arguments: {} });
    await client.callTool({ name: 'get_company', arguments: {} });
    await client.callTool({ name: 'get_company', arguments: { account: 'firma' } });
    const unknown = await client.callTool({ name: 'get_company', arguments: { account: 'nope' } });

    // assert
    expect(tools[0]?.name).toBe('list_accounts');
    const company = tools.find((t) => t.name === 'get_company');
    expect((company?.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty('account');
    expect(listed.structuredContent).toMatchObject({
      default_account: 'demo',
      accounts: [
        { name: 'demo', label: 'Veřejné DEMO', tenant: 'test.demo.uol.cz', demo: true, default: true },
        { name: 'firma', label: null, tenant: 'firma.ucetnictvi.uol.cz', demo: false, default: false },
      ],
    });
    expect(JSON.stringify(listed.content)).not.toContain('secret');
    expect(requests.map((r) => r.url.host)).toEqual(['test.demo.uol.cz', 'firma.ucetnictvi.uol.cz']);
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toMatch(/expected one of/);
  });
});
