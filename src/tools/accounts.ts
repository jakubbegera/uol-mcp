import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type ToolContext, registerReadTool } from './context.js';

/** Registered only with UOL_PROFILES_FILE; lists the accounts without their credentials. */
export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  const accounts = ctx.config.accounts ?? [];
  registerReadTool(
    server,
    ctx,
    'list_accounts',
    {
      title: 'List UOL accounts',
      description:
        'The UOL tenants (companies) this server can access. Pass a name as `account` to any other tool; without it the default account is used.',
      input: z.object({}),
      output: z.object({
        default_account: z.string(),
        accounts: z.array(
          z.object({
            name: z.string(),
            label: z.string().nullable(),
            tenant: z.string().describe('UOL host'),
            demo: z.boolean(),
            default: z.boolean(),
          }),
        ),
      }),
    },
    async () => ({
      data: {
        default_account: ctx.config.defaultAccount ?? '',
        accounts: accounts.map((a) => ({
          name: a.name,
          label: a.label ?? null,
          tenant: new URL(a.credentials.baseUrl).host,
          demo: a.credentials.isDemo,
          default: a.name === ctx.config.defaultAccount,
        })),
      },
    }),
  );
}
