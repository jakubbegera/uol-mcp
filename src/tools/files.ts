import { pathToFileURL } from 'node:url';
import type { ContentBlock } from '@modelcontextprotocol/server';
import type { AppConfig } from '../config.js';
import { saveDownload } from '../domain/files.js';

/**
 * Hands a downloaded file to the client: saved under UOL_DOWNLOAD_DIR with a
 * `resource_link` for local transports, or embedded in the result for the HTTP
 * transport, whose clients can't read the server's disk.
 */
export async function deliverFile(
  config: AppConfig,
  name: string,
  bytes: Buffer,
  mimeType: string,
): Promise<{ path: string | null; blocks: ContentBlock[] }> {
  if (config.embedFiles) {
    return {
      path: null,
      blocks: [
        { type: 'resource', resource: { uri: `uol://files/${encodeURIComponent(name)}`, mimeType, blob: bytes.toString('base64') } },
      ],
    };
  }
  const path = await saveDownload(config.downloadDir, name, bytes);
  return { path, blocks: [{ type: 'resource_link', uri: pathToFileURL(path).href, name, mimeType }] };
}
