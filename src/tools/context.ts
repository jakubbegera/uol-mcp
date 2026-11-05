import type {
  CallToolResult,
  ContentBlock,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { type z, z as zod } from 'zod';
import { type Access, type AppConfig, ConfigError, SETUP_HINT, allows } from '../config.js';
import { ContactNames } from '../domain/contact-names.js';
import { UnpaidReceivables } from '../domain/receivables.js';
import { InputError } from '../domain/uploads.js';
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
  /**
   * The session for [account] (UOL_PROFILES_FILE), or for the only / default
   * tenant when omitted. Throws [ConfigError] when the server runs without
   * usable credentials and [InputError] for an unknown account.
   */
  session(account?: string): UolSession;
  /** The access level of [account] (or the default one): its own, else UOL_ACCESS. */
  accessFor(account?: string): { account?: string; access: Access };
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

export interface ToolDefinition<I extends z.ZodObject, O extends z.ZodObject> {
  title: string;
  description: string;
  input: I;
  output: O;
}

/** Registers a read-only tool; see [registerTool]. */
export function registerReadTool<I extends z.ZodObject, O extends z.ZodObject>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  def: ToolDefinition<I, O>,
  run: (args: z.output<I>, session: UolSession) => Promise<ToolOutput<z.output<O>>>,
): void {
  registerTool(server, ctx, name, def, READ_ONLY, run);
}

/**
 * Registers a tool. The handler returns structured data; this wrapper adds
 * the JSON text block the spec asks for (clients that ignore
 * `structuredContent` still see the data) and turns failures into tool errors
 * the model can act on instead of protocol errors.
 */
export function registerTool<I extends z.ZodObject, O extends z.ZodObject>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  def: ToolDefinition<I, O>,
  annotations: Omit<ToolAnnotations, 'title'>,
  run: (args: z.output<I>, session: UolSession) => Promise<ToolOutput<z.output<O>>>,
  needs: Access = annotations.readOnlyHint ? 'read' : 'write',
): void {
  // With several accounts every tool takes `account`; the wrapper picks the session.
  const accounts = ctx.config.accounts ?? [];
  const input =
    accounts.length > 1
      ? def.input.extend({
          account: zod
            .enum(accounts.map((a) => a.name) as [string, ...string[]])
            .optional()
            .describe(`Which UOL account (list_accounts); default "${ctx.config.defaultAccount}"`),
        })
      : def.input;

  // The SDK has already validated [args] against the input schema; TypeScript just
  // can't follow the schema → type inference through this generic wrapper.
  const handler = async (args: unknown): Promise<CallToolResult> => {
    try {
      const account = (args as { account?: string }).account;
      // Tools are registered for the highest level any account has; each call checks its own account.
      const granted = ctx.accessFor(account);
      if (!allows(granted.access, needs)) {
        throw new InputError(
          `${name} needs ${needs} access, but account "${granted.account}" allows only ${granted.access}.`,
        );
      }
      const { data, extra } = await run(args as z.output<I>, ctx.session(account));
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
      inputSchema: input as StandardSchemaWithJSON,
      outputSchema: def.output as StandardSchemaWithJSON,
      annotations: { title: def.title, ...annotations },
    },
    handler,
  );
}

export function describeError(error: unknown): string {
  if (error instanceof ConfigError) return `uol-mcp is not configured: ${error.message}. ${SETUP_HINT}`;
  if (error instanceof InputError) return `Invalid input: ${error.message}`;
  if (error instanceof UolApiError) {
    const code = error.code === String(error.status) ? '' : `, ${error.code}`;
    return `UOL API error (HTTP ${error.status}${code}): ${error.message}`;
  }
  if (error instanceof Error) return `Unexpected error: ${error.message}`;
  return `Unexpected error: ${String(error)}`;
}

/** Registers a tool only accounts with `full` access may run: deletes, repairs, raw writes. */
export function registerFullTool<I extends z.ZodObject, O extends z.ZodObject>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  def: ToolDefinition<I, O>,
  annotations: Omit<ToolAnnotations, 'title'>,
  run: (args: z.output<I>, session: UolSession) => Promise<ToolOutput<z.output<O>>>,
): void {
  registerTool(server, ctx, name, def, annotations, run, 'full');
}
