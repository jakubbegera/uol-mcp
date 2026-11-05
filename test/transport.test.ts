import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { type AppConfig, loadConfig } from '../src/config.js';
import { type HttpOptions, startHttpServer } from '../src/http.js';
import { fakeUolFetch } from './support/fake-uol.js';

let server: Server | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  server?.close();
  client = undefined;
  server = undefined;
});

async function start(config: AppConfig, options: Partial<HttpOptions> = {}) {
  const { fetch, requests } = fakeUolFetch();
  server = await startHttpServer(config, { host: '127.0.0.1', port: 0, ...options }, { fetch });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, requests };
}

async function connect(url: string, headers: Record<string, string>) {
  client = new Client({ name: 'transport-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

const post = (url: string, headers: Record<string, string>) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

/** fetch() can't override Host, node:http can. */
function postWithHost(url: string, host: string): Promise<number> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host, 'x-uol-tenant': 'demo' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

describe('pass-through mode', () => {
  it('reads no files from the server disk unless UOL_UPLOAD_DIRS is set', async () => {
    // arrange
    const { url, requests } = await start(loadConfig({ UOL_ACCESS: 'write' }));
    const mcp = await connect(url, { 'X-UOL-Tenant': 'demo' });

    // act
    const result = await mcp.callTool({ name: 'upload_document', arguments: { file_path: '~/Documents/x.pdf' } });

    // assert
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/content_base64/);
    expect(requests).toEqual([]);
  });

  it('serves tools with credentials from the request headers and embeds files', async () => {
    // arrange
    const { url, requests } = await start(loadConfig({}));
    const mcp = await connect(url, { 'X-UOL-Tenant': 'demo' });

    // act
    const company = await mcp.callTool({ name: 'get_company', arguments: {} });
    const pdf = await mcp.callTool({ name: 'export_sales_invoice', arguments: { invoice_id: '2026000044' } });

    // assert
    expect((company.structuredContent as { name: string }).name).toBe('DEMO, s. r. o.');
    expect(requests[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('demo@ucetnictvi-on-line.cz:3R1Cc_wzcSuq02Wsh1-uww').toString('base64')}`,
    );
    expect((pdf.structuredContent as { file_path: string | null }).file_path).toBeNull();
    const embedded = pdf.content.find((c) => c.type === 'resource') as { resource: { mimeType: string; blob: string } };
    expect(Buffer.from(embedded.resource.blob, 'base64').toString()).toBe('%PDF-1.4 fake');
  });

  it('asks for the UOL headers when they are missing or incomplete', async () => {
    // arrange
    const { url } = await start(loadConfig({}));

    // act
    const none = await post(url, {});
    const halfway = await post(url, { 'x-uol-tenant': 'firma', 'x-uol-email': 'a@b.cz' });
    const foreign = await post(url, { 'x-uol-tenant': 'https://evil.example' });

    // assert
    expect(none.status).toBe(401);
    expect(await none.text()).toMatch(/X-UOL-Tenant/);
    expect(halfway.status).toBe(401);
    expect(foreign.status).toBe(401);
    expect(await foreign.text()).toMatch(/uol\.cz/);
  });

  it('answers /health and rejects unknown paths', async () => {
    // arrange
    const { url } = await start(loadConfig({}));

    // act
    const health = await fetch(url.replace('/mcp', '/health'));
    const other = await fetch(url.replace('/mcp', '/admin'));

    // assert
    expect(await health.json()).toMatchObject({ status: 'ok', mode: 'pass-through' });
    expect(other.status).toBe(404);
  });

  it('blocks foreign Host and Origin headers on a loopback bind', async () => {
    // arrange
    const { url } = await start(loadConfig({}));

    // act
    const host = await postWithHost(url, 'evil.example');
    const origin = await post(url, { origin: 'https://evil.example', 'x-uol-tenant': 'demo' });

    // assert
    expect(host).toBe(403);
    expect(origin.status).toBe(403);
  });
});

describe('single-tenant mode', () => {
  it('refuses to start without MCP_AUTH_TOKEN', async () => {
    await expect(startHttpServer(loadConfig({ UOL_TENANT: 'demo' }), { host: '127.0.0.1', port: 0 })).rejects.toThrow(
      /MCP_AUTH_TOKEN is required/,
    );
  });

  it('requires the bearer token and refuses per-request credentials', async () => {
    // arrange
    const { url } = await start(loadConfig({ UOL_TENANT: 'demo' }), { authToken: 's3cret' });

    // act
    const missing = await post(url, {});
    const wrong = await post(url, { authorization: 'Bearer nope' });
    const smuggled = await post(url, { authorization: 'Bearer s3cret', 'x-uol-tenant': 'other' });
    const mcp = await connect(url, { Authorization: 'Bearer s3cret' });
    const tools = await mcp.listTools();

    // assert
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect(wrong.status).toBe(401);
    expect(smuggled.status).toBe(400);
    expect(tools.tools.length).toBeGreaterThan(0);
  });
});
