import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { type AuditEntry, audit } from '../domain/audit.js';
import type { ToolContext, UolSession } from './context.js';

/** Appended to every write tool's description. */
export const CONFIRM_FIRST =
  'Before calling without dry_run, show the user what will be sent and get their explicit confirmation.';

export const WRITE: Omit<ToolAnnotations, 'title'> = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const DESTRUCTIVE: Omit<ToolAnnotations, 'title'> = { ...WRITE, destructiveHint: true };

/** Drops undefined keys so request bodies only carry what the caller set. */
export function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}

/**
 * Runs one write and records it in the audit log, success or failure. The
 * error is re-thrown unchanged so the tool reports UOL's own message.
 */
export async function auditedWrite<T>(
  session: UolSession,
  ctx: ToolContext,
  entry: Omit<AuditEntry, 'outcome' | 'result_id' | 'error' | 'tenant'>,
  send: () => Promise<T>,
  resultId: (result: T) => string | null,
): Promise<T> {
  const logged = { ...entry, tenant: tenantOf(session) };
  try {
    const result = await send();
    await audit(session.config.auditLog, { ...logged, outcome: 'ok', result_id: resultId(result) }, ctx.now());
    return result;
  } catch (error) {
    await audit(session.config.auditLog, { ...logged, outcome: 'error', error: String(error) }, ctx.now());
    throw error;
  }
}

export function tenantOf(session: UolSession): string {
  return new URL(session.client.http.baseUrl).host;
}
