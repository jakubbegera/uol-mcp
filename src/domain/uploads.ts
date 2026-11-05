import { realpath, stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';

/** UOL accepts PDF uploads; larger files are rejected before anything is sent. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Invalid tool input the model can fix (wrong path, wrong file type, …). */
export class InputError extends Error {}

export interface UploadFile {
  name: string;
  bytes: Buffer;
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith(`~${sep}`) || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/**
 * Reads a PDF the user wants to upload. The path must resolve — symlinks
 * included — inside one of [allowedDirs]; otherwise a prompt-injected request
 * could ship arbitrary local files into the accounting system.
 */
export async function readUploadFile(filePath: string, allowedDirs: string[]): Promise<UploadFile> {
  if (allowedDirs.length === 0) {
    throw new InputError('This server takes no file paths; send the file as content_base64 instead.');
  }
  const expanded = expandHome(filePath.trim());
  if (!isAbsolute(expanded)) throw new InputError('file_path must be an absolute path (or start with ~/).');

  let real: string;
  try {
    real = await realpath(resolve(expanded));
  } catch {
    throw new InputError(`File not found: ${filePath}`);
  }
  const roots = await Promise.all(allowedDirs.map((d) => realpath(resolve(expandHome(d))).catch(() => undefined)));
  const allowed = roots.filter((r): r is string => Boolean(r));
  if (!allowed.some((root) => real === root || real.startsWith(`${root}${sep}`))) {
    throw new InputError(
      `${filePath} is outside the folders uol-mcp may upload from (${allowedDirs.join(', ')}). ` +
        'Move the file there or set UOL_UPLOAD_DIRS.',
    );
  }

  const info = await stat(real);
  if (!info.isFile()) throw new InputError(`${filePath} is not a file.`);
  if (info.size > MAX_UPLOAD_BYTES) throw new InputError(`${filePath} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  return checkPdf({ name: basename(real), bytes: await readFile(real) });
}

export function decodeUpload(contentBase64: string, fileName: string | undefined): UploadFile {
  if (!fileName) throw new InputError('file_name is required together with content_base64.');
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new InputError(`The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  return checkPdf({ name: basename(fileName), bytes });
}

function checkPdf(file: UploadFile): UploadFile {
  if (!file.name.toLowerCase().endsWith('.pdf')) throw new InputError('Only PDF files can be uploaded to UOL.');
  if (file.bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new InputError(`${file.name} does not look like a PDF (missing %PDF- header).`);
  }
  return file;
}
