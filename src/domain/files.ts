import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Characters that are invalid on at least one of Windows / macOS / Linux. */
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;

const clean = (name: string) => name.replace(UNSAFE, '_').replace(/^\.+/, '').trim().slice(0, 180);

/**
 * A file name that stays inside the download folder. The fallback is cleaned too: it is built
 * from ids the model passes in, so it is no more trusted than the name UOL sends.
 */
export function safeFileName(name: string | undefined, fallback: string): string {
  return clean(name ?? '') || clean(fallback) || 'download';
}

/**
 * Writes [bytes] into [dir] (created on demand) and returns the absolute path. An existing
 * file is never replaced: a taken name gets a " (1)", " (2)" … suffix, as browsers do.
 * Files are readable by the owner only, since they hold accounting documents.
 */
export async function saveDownload(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  const dot = name.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 0; n < 1000; n++) {
    const path = join(target, n === 0 ? name : `${stem} (${n})${extension}`);
    try {
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`${target} already holds 1000 files named like ${name}`);
}
