import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

export interface AuditEntry {
  tool: string;
  method: string;
  path: string;
  /** Hash of the request body, so the log proves what was sent without storing it. */
  payload: unknown;
  outcome: 'ok' | 'error';
  result_id?: string | null;
  idempotency_key?: string;
  error?: string;
}

/**
 * Appends one JSON line per write to [file]. Never throws: a broken audit
 * log must not turn a successful write into a reported failure.
 */
export async function audit(file: string | undefined, entry: AuditEntry, now: Date = new Date()): Promise<void> {
  if (!file) return;
  const { payload, ...rest } = entry;
  const line = {
    ts: now.toISOString(),
    ...rest,
    payload_sha256: createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex'),
  };
  try {
    await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`uol-mcp: audit log ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
