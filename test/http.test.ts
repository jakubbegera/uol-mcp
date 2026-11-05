import { describe, expect, it } from 'vitest';
import { DEMO } from '../src/config.js';
import { errorFromResponse } from '../src/uol/errors.js';
import { MAX_DOWNLOAD_BYTES, UolHttp, fileNameFromContentDisposition } from '../src/uol/http.js';
import { RateLimiter, bucketFor } from '../src/uol/rate-limit.js';
import { fakeUolFetch, fixture } from './support/fake-uol.js';

const credentials = { baseUrl: DEMO.baseUrl, email: DEMO.email, token: DEMO.token, isDemo: true };

describe('fileNameFromContentDisposition', () => {
  it.each([
    ['inline; filename="faktura.pdf"', 'faktura.pdf'],
    ["attachment; filename*=UTF-8''Faktura%20vystaven%C3%A1.pdf", 'Faktura vystavená.pdf'],
    ['attachment; filename="x.pdf"; filename*=UTF-8\'\'y.pdf', 'y.pdf'],
    // raw UTF-8 bytes as fetch exposes them (Latin-1), seen on live UOL
    [`inline; filename="${Buffer.from('vystavená.pdf').toString('latin1')}"`, 'vystavená.pdf'],
    // decomposed accents (a + U+0301) are normalised
    ['inline; filename="vystavena%CC%81.pdf"', 'vystavená.pdf'],
    ['attachment; filename="../../etc/passwd"', 'passwd'],
    ['inline', undefined],
    [null, undefined],
  ])('%s → %s', (header, expected) => {
    expect(fileNameFromContentDisposition(header)).toBe(expected);
  });
});

describe('errorFromResponse', () => {
  it('uses the UOL message and adds a hint for the code', () => {
    // arrange
    const body = JSON.stringify(fixture('err_401'));

    // act
    const error = errorFromResponse(401, body);

    // assert
    expect(error.code).toBe('0002');
    expect(error.message).toMatch(/Authentication failed/);
    expect(error.message).toMatch(/REST API/);
  });

  it('surfaces validation codes verbatim', () => {
    // arrange
    const body = JSON.stringify({
      message: 'Validation failed',
      errors: [{ resource: 'UploadedDocument', field: 'file', code: "It's already uploaded. (43)" }],
    });

    // act
    const error = errorFromResponse(422, body);

    // assert
    expect(error.code).toBe('validation');
    expect(error.message).toBe("Validation failed — file: It's already uploaded. (43)");
  });

  it('explains a missing permission (0014)', () => {
    // arrange
    const body = JSON.stringify({ status: '403', code: '0014', message: 'You are not authorized to perform this action.' });

    // act
    const error = errorFromResponse(403, body);

    // assert
    expect(error.code).toBe('0014');
    expect(error.message).toMatch(/lacks the permission/);
  });

  it('explains the rate limit', () => {
    expect(errorFromResponse(429, '').code).toBe('rate_limited');
  });

  it('copes with a non-JSON body', () => {
    expect(errorFromResponse(502, '<html>').message).toBe('UOL answered HTTP 502.');
  });
});

describe('UolHttp', () => {
  it('sends Basic auth and a single JSON Accept header', async () => {
    // arrange
    const { fetch, requests } = fakeUolFetch();
    const http = new UolHttp(credentials, { fetch });

    // act
    await http.getJson('/v1/ping');

    // assert
    const [request] = requests;
    expect(request?.headers.authorization).toBe(`Basic ${Buffer.from(`${DEMO.email}:${DEMO.token}`).toString('base64')}`);
    expect(request?.headers.accept).toBe('application/json');
  });

  it('percent-encodes "+" in query values and skips empty ones', () => {
    // arrange
    const http = new UolHttp(credentials);

    // act
    const url = http.apiUrl('/v1/uploaded_documents', {
      created_at_from: '2025-09-01T10:00:00+02:00',
      state: undefined,
      q: '',
    });

    // assert
    expect(url).toBe('https://test.demo.uol.cz/api/v1/uploaded_documents?created_at_from=2025-09-01T10%3A00%3A00%2B02%3A00');
  });

  it('does not send credentials to foreign hosts', async () => {
    // arrange
    const { fetch, requests } = fakeUolFetch();
    const http = new UolHttp(credentials, { fetch });

    // act
    await http.getBinary('https://s3.eu-central-1.amazonaws.com/bucket/doc.pdf?X-Amz-Signature=abc').catch(() => undefined);

    // assert
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  it('resolves legacy tenant-relative file paths against the tenant origin', () => {
    expect(new UolHttp(credentials).resolveFileUrl('/customers/test/uploaded_documents/a.pdf')).toBe(
      'https://test.demo.uol.cz/customers/test/uploaded_documents/a.pdf',
    );
  });

  it('turns 404 bodies into UolApiError', async () => {
    // arrange
    const { fetch } = fakeUolFetch();
    const http = new UolHttp(credentials, { fetch });

    // act
    const error = await http.getJson('/v1/sales_invoices/1').catch((e: unknown) => e);

    // assert
    expect(error).toMatchObject({ status: 404, code: '0004' });
  });

  it.each([
    ['announced by Content-Length', true],
    ['found while reading the body', false],
  ])('refuses a download larger than the cap (%s)', async (_case, announce) => {
    // arrange
    // An endless body: the test only finishes if the download stops at the cap.
    const chunk = new Uint8Array(1024 * 1024);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = announce ? { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } : undefined;
    const http = new UolHttp(credentials, { fetch: async () => new Response(body, { status: 200, headers }) });

    // act
    const error = await http.getBinary(`${DEMO.baseUrl}/v1/sales_invoices/1`, 'application/pdf').catch((e: unknown) => e);

    // assert
    expect(error).toMatchObject({ status: 413, code: 'file_too_large' });
    expect(cancelled).toBe(true);
  });
});

describe('RateLimiter', () => {
  it('waits for the window once the bucket is full', async () => {
    // arrange
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(
      { general: { requests: 2, windowMs: 1_000 } },
      () => now,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    );

    // act
    await limiter.acquire('general');
    await limiter.acquire('general');
    await limiter.acquire('general');

    // assert
    expect(sleeps).toEqual([1_000]);
  });

  it('routes receivables to their own bucket', () => {
    expect(bucketFor('/v1/receivables')).toBe('receivables');
    expect(bucketFor('/v1/receivables/2026000001')).toBe('receivables');
    expect(bucketFor('/v1/sales_invoices')).toBe('general');
  });
});
