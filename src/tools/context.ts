import type { CallToolResult, ContentBlock, McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { type AppConfig, ConfigError, SETUP_HINT } from '../config.js';
import { ContactNames } from '../domain/contact-names.js';
import { UnpaidReceivables } from '../domain/receivables.js';
import { UolClient } from '../uol/client.js';
import { UolApiError } from '../uol/errors.js';
import { UolHttp } from '../uol/http.js';

/** Everything a tool needs to talk to one UOL tenant. */
export class UolSession {
  readonly client: UolClient;
  readonly contacts: ContactNames;
  readonly unpaid: UnpaidReceivables;

  constructor(
    readonly config: AppConfig,
    http: UolHttp,
  ) {
    this.client = new UolClient(http);
    this.contacts = new ContactNames(this.client);
    this.unpaid = new UnpaidReceivables(this.client);
  }
}

export interface ToolContext {
  config: AppConfig;
  /** Throws [ConfigError] when the server runs without usable credentials. */
  session(): UolSession;
  now(): Date;
}

export interface ToolOutput<T> {
  data: T;
  /** Content blocks after the JSON one: a file link, an ISDOC document, … */
  extra?: ContentBlock[];
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Registers a read-only tool. The handler returns structured data; this
 * wrapper adds the JSON text block the spec asks for (clients that ignore
 * `structuredContent` still see the data) and turns failures into tool errors
 * the model can act on instead of protocol errors.
 */
export function registerReadTool<I extends z.ZodObject, O extends z.ZodObject>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  def: { title: string; description: string; input: I; output: O },
  run: (args: z.output<I>, session: UolSession) => Promise<ToolOutput<z.output<O>>>,
): void {
  // The SDK has already validated [args] against def.input; TypeScript just can't
  // follow the schema → type inference through this generic wrapper.
  const handler = async (args: unknown): Promise<CallToolResult> => {
    try {
      const { data, extra } = await run(args as z.output<I>, ctx.session());
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }, ...(extra ?? [])],
        structuredContent: data as Record<string, unknown>,
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: describeError(error) }] };
    }
  };
  server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input as StandardSchemaWithJSON,
      outputSchema: def.output as StandardSchemaWithJSON,
      annotations: { title: def.title, ...READ_ONLY },
    },
    handler,
  );
}

export function describeError(error: unknown): string {
  if (error instanceof ConfigError) return `uol-mcp is not configured: ${error.message}. ${SETUP_HINT}`;
  if (error instanceof UolApiError) return `UOL API error (HTTP ${error.status}, ${error.code}): ${error.message}`;
  if (error instanceof Error) return `Unexpected error: ${error.message}`;
  return `Unexpected error: ${String(error)}`;
}
