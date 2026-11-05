import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, decodeUpload, readUploadFile } from '../src/domain/uploads.js';

const PDF = Buffer.from('%PDF-1.4 test');

function folders() {
  const root = mkdtempSync(join(tmpdir(), 'uol-mcp-uploads-'));
  const allowed = join(root, 'allowed');
  const secret = join(root, 'secret');
  mkdirSync(allowed);
  mkdirSync(secret);
  return { allowed, secret };
}

describe('readUploadFile', () => {
  it('takes no file paths when no folder is allowed', async () => {
    // arrange
    const { allowed } = folders();
    writeFileSync(join(allowed, 'a.pdf'), PDF);

    // act
    const read = readUploadFile(join(allowed, 'a.pdf'), []);

    // assert
    await expect(read).rejects.toThrow(/content_base64/);
  });

  it('reads a PDF inside an allowed folder', async () => {
    // arrange
    const { allowed } = folders();
    writeFileSync(join(allowed, 'a.pdf'), PDF);

    // act
    const file = await readUploadFile(join(allowed, 'a.pdf'), [allowed]);

    // assert
    expect(file).toEqual({ name: 'a.pdf', bytes: PDF });
  });

  it('follows symlinks before checking the folder, so a link cannot smuggle a file out', async () => {
    // arrange
    const { allowed, secret } = folders();
    writeFileSync(join(secret, 'private.pdf'), PDF);
    symlinkSync(join(secret, 'private.pdf'), join(allowed, 'innocent.pdf'));

    // act
    const attempt = readUploadFile(join(allowed, 'innocent.pdf'), [allowed]);

    // assert
    await expect(attempt).rejects.toThrow(/outside the folders/);
  });

  it('rejects .. traversal out of the folder', async () => {
    // arrange
    const { allowed, secret } = folders();
    writeFileSync(join(secret, 'b.pdf'), PDF);

    // act
    const attempt = readUploadFile(join(allowed, '..', 'secret', 'b.pdf'), [allowed]);

    // assert
    await expect(attempt).rejects.toThrow(/outside the folders/);
  });

  it.each([
    ['relative path', 'a.pdf', /absolute/],
    ['missing file', '/nonexistent/x.pdf', /not found/],
  ])('rejects a %s', async (_case, path, message) => {
    await expect(readUploadFile(path, ['/'])).rejects.toThrow(message);
  });

  it('rejects other file types', async () => {
    // arrange
    const { allowed } = folders();
    writeFileSync(join(allowed, 'a.txt'), PDF);

    // act
    const attempt = readUploadFile(join(allowed, 'a.txt'), [allowed]);

    // assert
    await expect(attempt).rejects.toThrow(/Only PDF/);
  });
});

describe('decodeUpload', () => {
  it('needs a file name and PDF content', () => {
    expect(() => decodeUpload(PDF.toString('base64'), undefined)).toThrow(/file_name is required/);
    expect(() => decodeUpload(Buffer.from('nope').toString('base64'), 'x.pdf')).toThrow(/does not look like a PDF/);
    expect(decodeUpload(PDF.toString('base64'), 'dir/x.pdf').name).toBe('x.pdf');
  });

  it('enforces the size cap', () => {
    // arrange
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_UPLOAD_BYTES)]);

    // act
    const attempt = () => decodeUpload(big.toString('base64'), 'big.pdf');

    // assert
    expect(attempt).toThrow(/larger than/);
  });
});
