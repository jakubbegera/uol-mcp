import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Characters that are invalid on at least one of Windows / macOS / Linux. */
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;

export function safeFileName(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? '').replace(UNSAFE, '_').replace(/^\.+/, '').trim().slice(0, 180);
  return cleaned || fallback;
}

/** Writes [bytes] into [dir] (created on demand) and returns the absolute path. */
export async function saveDownload(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  const path = join(target, name);
  await writeFile(path, bytes);
  return path;
}
