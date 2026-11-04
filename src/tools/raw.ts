import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type ToolContext, registerReadTool } from './context.js';

/** Keeps a raw answer inside a sensible share of the model's context. */
export const MAX_RAW_CHARS = 60_000;

const PATH = /^\/?v1\/[a-z0-9_/{}.-]*$/i;

export function registerRawTools(server: McpServer, ctx: ToolContext): void {
  registerReadTool(
    server,
    ctx,
    'api_get',
    {
      title: 'Raw UOL GET',
      description:
        'Read-only GET of any UOL REST path (spec: https://api.uol.cz/openapi.yaml) for data no other tool covers — ' +
        'e.g. /v1/accounting_records, /v1/bank_movements, /v1/products, /v1/warehouse/statuses, /v1/sales_orders. ' +
        'Returns the raw JSON (amounts as strings, invoice status "valid" = draft); large answers are cut to fit. Prefer the dedicated tools.',
      input: z.object({
        path: z.string().describe('Path under the API root starting with /v1/, e.g. /v1/products'),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Query parameters, e.g. {"page": 1, "per_page": 50}'),
      }),
      output: z.object({
        path: z.string(),
        truncated: z.boolean(),
        data: z.unknown(),
      }),
    },
    async ({ path, query }, { client }) => {
      if (!PATH.test(path) || path.includes('..')) {
        throw new Error('path must be a relative API path starting with /v1/ (no scheme, host or "..")');
      }
      const normalized = path.startsWith('/') ? path : `/${path}`;
      const data = await client.get(normalized, query);
      const { value, truncated } = fit(data);
      return { data: { path: normalized, truncated, data: value } };
    },
  );
}

/** Drops trailing `items` until the JSON fits; non-list bodies that are still too large become a text excerpt. */
function fit(data: unknown): { value: unknown; truncated: boolean } {
  if (JSON.stringify(data).length <= MAX_RAW_CHARS) return { value: data, truncated: false };
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    const body = { ...(data as Record<string, unknown>) };
    const items = [...(body.items as unknown[])];
    while (items.length > 0 && JSON.stringify({ ...body, items }).length > MAX_RAW_CHARS) items.pop();
    return { value: { ...body, items }, truncated: true };
  }
  return { value: JSON.stringify(data).slice(0, MAX_RAW_CHARS), truncated: true };
}
