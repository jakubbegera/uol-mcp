import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEMO, loadConfig, parseToolsets, resolveTenant } from '../src/config.js';

describe('resolveTenant', () => {
  it.each([
    ['demo', DEMO.baseUrl],
    ['firma', 'https://firma.ucetnictvi.uol.cz/api'],
    ['firma.ucetnictvi', 'https://firma.ucetnictvi.uol.cz/api'],
    ['firma.sandbox', 'https://firma.sandbox.uol.cz/api'],
    ['Firma.Ucetnictvi.uol.cz', 'https://firma.ucetnictvi.uol.cz/api'],
    ['https://firma.ucetnictvi.uol.cz', 'https://firma.ucetnictvi.uol.cz/api'],
    ['https://firma.ucetnictvi.uol.cz/api/v1/', 'https://firma.ucetnictvi.uol.cz/api'],
    ['https://test.demo.uol.cz/api', DEMO.baseUrl],
  ])('%s → %s', (input, expected) => {
    expect(resolveTenant(input).baseUrl).toBe(expected);
  });

  it.each([
    ['http://firma.ucetnictvi.uol.cz', /https/],
    ['https://uol.cz.evil.example', /\*\.uol\.cz/],
    ['https://example.com/api', /\*\.uol\.cz/],
    ['firma/../x', /unexpected characters/],
    ['  ', /empty/],
  ])('rejects %s', (input, message) => {
    expect(() => resolveTenant(input)).toThrow(message);
  });

  it('flags the DEMO tenant', () => {
    expect(resolveTenant('https://test.demo.uol.cz').isDemo).toBe(true);
    expect(resolveTenant('firma').isDemo).toBe(false);
  });
});

describe('loadConfig', () => {
  it('runs unconfigured when nothing is set', () => {
    // act
    const config = loadConfig({});

    // assert
    expect(config.credentials).toBeUndefined();
    expect(config.configError).toBeUndefined();
  });

  it('fills the public credentials for UOL_TENANT=demo', () => {
    // act
    const config = loadConfig({ UOL_TENANT: 'demo' });

    // assert
    expect(config.credentials).toEqual({ baseUrl: DEMO.baseUrl, email: DEMO.email, token: DEMO.token, isDemo: true });
  });

  it('reports a half-filled credential pair instead of throwing', () => {
    // act
    const config = loadConfig({ UOL_TENANT: 'firma', UOL_EMAIL: 'a@b.cz' });

    // assert
    expect(config.credentials).toBeUndefined();
    expect(config.configError).toMatch(/UOL_EMAIL and UOL_TOKEN/);
  });

  it('reports a missing tenant', () => {
    expect(loadConfig({ UOL_EMAIL: 'a@b.cz', UOL_TOKEN: 't' }).configError).toMatch(/UOL_TENANT is missing/);
  });

  it('honours UOL_DOWNLOAD_DIR and UOL_TIMEOUT_MS', () => {
    // act
    const config = loadConfig({ UOL_DOWNLOAD_DIR: '/tmp/x', UOL_TIMEOUT_MS: '1234' });

    // assert
    expect(config.downloadDir).toBe('/tmp/x');
    expect(config.requestTimeoutMs).toBe(1234);
  });

  it.each([
    [undefined, ['core', 'insights'], []],
    ['all', ['core', 'insights'], []],
    ['core', ['core'], []],
    [' Insights , bogus ', ['insights'], ['bogus']],
  ])('parses UOL_TOOLSETS=%j', (raw, toolsets, unknown) => {
    // act
    const result = parseToolsets(raw);

    // assert
    expect([...result.toolsets]).toEqual(toolsets);
    expect(result.unknown).toEqual(unknown);
  });

  it.each([
    [undefined, 'read', 0],
    ['write', 'write', 0],
    ['FULL', 'full', 0],
    ['admin', 'read', 1],
  ])('parses UOL_ACCESS=%j as %s', (raw, access, warnings) => {
    // act
    const config = loadConfig({ UOL_ACCESS: raw });

    // assert
    expect(config.access).toBe(access);
    expect(config.warnings).toHaveLength(warnings);
  });

  it('splits UOL_UPLOAD_DIRS on the platform delimiter and defaults to the usual user folders', () => {
    // act
    const custom = loadConfig({ UOL_UPLOAD_DIRS: `/a${delimiter}/b${delimiter}` });
    const fallback = loadConfig({});

    // assert
    expect(custom.uploadDirs).toEqual(['/a', '/b']);
    expect(fallback.uploadDirs?.map((d) => d.split(/[\\/]/).pop())).toEqual(['Downloads', 'Desktop', 'Documents']);
  });

  it('treats unexpanded host placeholders as unset', () => {
    // act
    const config = loadConfig({
      UOL_TENANT: 'demo',
      UOL_EMAIL: '${user_config.email}',
      UOL_TOKEN: '${user_config.token}',
      UOL_DOWNLOAD_DIR: '${user_config.download_dir}',
    });

    // assert
    expect(config.credentials?.email).toBe(DEMO.email);
    expect(config.downloadDir).not.toContain('${');
  });

  it('warns about unknown toolsets instead of failing', () => {
    expect(loadConfig({ UOL_TOOLSETS: 'core,ledger' }).warnings?.[0]).toMatch(/ledger/);
  });

  it('exposes ConfigError for callers', () => {
    expect(new ConfigError('x')).toBeInstanceOf(Error);
  });
});
