# uol-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for
[UOL Účetnictví](https://www.uol.cz) — ask Claude, Cursor or any other MCP client about your
bookkeeping: issued and received invoices, who owes you money, uploaded documents, contacts.

> **Unofficial.** Not affiliated with or endorsed by UOL a.s. It talks to the public
> [UOL REST API](https://api.uol.cz/) with your own API token.

[Česky](README.cs.md)

**Status:** v0.3 — read-only by default, opt-in writes. Not on npm yet; run it [from source](#from-source) until the first release.

## What it can do

| Tool | Answers |
|---|---|
| `get_business_snapshot` | How the company is doing, in one call: this month vs last, VAT, receivables, documents to process, bank |
| `get_financial_overview` | Revenue, expenses and profit per month from the general ledger, largest accounts |
| `get_vat_overview` | VAT per filing period: to pay or excess deduction, due date, final or estimate |
| `get_bank_balances` | Bank balances per account and currency (UOL keeps monthly snapshots) |
| `get_company` | Company name, IČO, DIČ, address, VAT filing period; doubles as a connection check |
| `search_sales_invoices`, `get_sales_invoice` | Issued invoices with line items, VAT and payment status |
| `search_purchase_invoices`, `get_purchase_invoice` | Received invoices |
| `list_receivables` | Who owes you, how much, how long overdue — totals per currency |
| `export_sales_invoice` | PDF or ISDOC of an issued invoice, saved to disk (ISDOC is also returned as XML) |
| `search_contacts`, `get_contact` | Customers and suppliers by name, IČO or DIČ, with addresses and bank accounts |
| `list_uploaded_documents`, `get_uploaded_document`, `download_uploaded_document` | Documents uploaded for the accountant, their state and files |
| `list_codebook` | Currencies, departments, contracts, price lists, own bank accounts, … |
| `api_get` | Read-only GET of any other `/v1/…` endpoint |

Example questions: *"Jak si letos stojíme?"*, *"Kolik zaplatím DPH za tento kvartál?"*,
*"Kdo mi dluží víc než 30 dní?"*, *"Je faktura 2026000123 zaplacená?"*,
*"Na čem nejvíc utrácíme?"*, *"Stáhni mi PDF poslední vydané faktury."*

Ready-made prompts (slash commands in most clients): `monthly_review`, `vat_check`,
`overdue_followup` (drafts reminders, sends nothing), `process_inbox`. The `uol://guide` resource
explains the domain to the model.

The server knows the API's quirks: invoice status `valid` means *draft*, payment status exists only
for issued invoices, credit notes come with positive amounts, revenue and expenses have to be read
from the ledger (excluding year-end closing entries), purchase invoices ignore issue-date filters,
files have three different download shapes, and the rate limit (30 requests / 10 s) is respected
client-side. See [docs/DESIGN.md](docs/DESIGN.md).

## Getting an API token

1. Open the API tokens page of your UOL tenant (path `/api_tokens`, e.g.
   `https://firma.ucetnictvi.uol.cz/api_tokens`) and create a token.
2. The UOL user needs the **REST API** permission. A dedicated user with only the rights you want
   the assistant to have is a good idea.

Your tenant is the first part of your UOL address: `https://firma.ucetnictvi.uol.cz` → `firma`.

Want to try it first? `UOL_TENANT=demo` uses UOL's public DEMO company, no token needed.

## Configuration

| Variable | Meaning |
|---|---|
| `UOL_TENANT` | `demo`, your tenant name (`firma`), a host prefix (`firma.sandbox`) or the full `https://….uol.cz` URL |
| `UOL_EMAIL` | E-mail you log into UOL with |
| `UOL_TOKEN` | API token |
| `UOL_DOWNLOAD_DIR` | Where exported and downloaded files go (default `~/Downloads/uol-mcp`) |
| `UOL_TOOLSETS` | `core`, `insights` or `all` (default) — fewer tools for clients with small tool budgets |
| `UOL_ACCESS` | `read` (default) or `write` — see [Writing](#writing-opt-in) |
| `UOL_UPLOAD_DIRS` | Folders `upload_document` may read from (default `~/Downloads`, `~/Desktop`, `~/Documents`; `:`-separated, `;` on Windows) |
| `UOL_AUDIT_LOG` | File that records every write as a JSON line |
| `UOL_DEBUG` | `1` logs requests to stderr (never credentials) |

### Claude Desktop

Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "uol": {
      "command": "npx",
      "args": ["-y", "uol-mcp"],
      "env": {
        "UOL_TENANT": "firma",
        "UOL_EMAIL": "you@example.com",
        "UOL_TOKEN": "your-token"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add uol -e UOL_TENANT=firma -e UOL_EMAIL=you@example.com -e UOL_TOKEN=your-token -- npx -y uol-mcp
```

### Cursor / VS Code

Cursor (`.cursor/mcp.json`) uses the same `mcpServers` block as Claude Desktop. VS Code
(`.vscode/mcp.json`):

```json
{
  "servers": {
    "uol": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "uol-mcp"],
      "env": { "UOL_TENANT": "firma", "UOL_EMAIL": "you@example.com", "UOL_TOKEN": "your-token" }
    }
  }
}
```

### Docker

```bash
docker run -i --rm -e UOL_TENANT=firma -e UOL_EMAIL=you@example.com -e UOL_TOKEN=your-token -v "$HOME/Downloads/uol-mcp:/data" ghcr.io/jakubbegera/uol-mcp
```

Exported and downloaded files are written to `/data` inside the container; the `-v` mount keeps them.
In an MCP client config, use `docker` as the command and the rest as `args`.

### Claude Desktop extension

Each release ships `uol-mcp.mcpb`. Open it to install, then fill in tenant, e-mail and token in the
form; the token is stored as a secret. `bash scripts/build-mcpb.sh` builds the bundle from source.

### HTTP server (self-hosting)

```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN=change-me UOL_TENANT=firma UOL_EMAIL=you@example.com UOL_TOKEN=your-token npx -y uol-mcp
```

The endpoint is `http://127.0.0.1:3000/mcp` (`HOST`, `PORT` to change; `/health` for probes).
Two modes:

- **One tenant**: UOL credentials in the server's env. Clients must send `Authorization: Bearer
  <MCP_AUTH_TOKEN>`; the server refuses to start without the token.
- **Pass-through**: no UOL credentials in the env. Each client sends its own `X-UOL-Tenant`,
  `X-UOL-Email` and `X-UOL-Token` headers with every request; the server stores nothing.
  `MCP_AUTH_TOKEN` is optional.

Over HTTP, exported invoices and downloaded documents come back inside the tool result instead of
being saved on the server. In Docker, bind to all interfaces and publish the port:
`docker run -p 3000:3000 -e MCP_TRANSPORT=http -e HOST=0.0.0.0 -e MCP_ALLOWED_HOSTS=mcp.example.com …`.

### Check the setup

```bash
UOL_TENANT=firma UOL_EMAIL=you@example.com UOL_TOKEN=your-token npx -y uol-mcp doctor
```

## Writing (opt-in)

With `UOL_ACCESS=write` three more tools appear:

| Tool | Does |
|---|---|
| `upload_document` | Uploads a PDF to UOL's document inbox for the accountant (only from `UOL_UPLOAD_DIRS`) |
| `create_sales_invoice` | Creates an issued invoice for an existing contact — a draft unless `issue: true` |
| `update_sales_invoice` | Changes or issues a draft invoice (UOL doesn't allow editing issued ones) |

Every write supports `dry_run` (shows exactly what would be sent), creates are safe to retry
(idempotency key), and the tools are marked so clients ask you before running them. Set
`UOL_AUDIT_LOG` to keep a record of every write.

## Privacy and safety

- Read-only unless you set `UOL_ACCESS=write`. Text inside invoices, notes and documents is treated
  as data: review what the assistant proposes to write before you approve it.
- Whatever the tools return goes to the AI model your client uses. Accounting data contains personal
  data of your contacts and employees — use a plan whose terms you are comfortable with.
- Credentials are used only for `https://*.uol.cz` and are never written to logs or tool output.
- Downloaded files are saved under `UOL_DOWNLOAD_DIR` only.

## From source

Requires Node.js 22+.

```bash
git clone https://github.com/jakubbegera/uol-mcp.git
cd uol-mcp
npm install
npm run build
```

Then point your client at `node /path/to/uol-mcp/dist/index.js` instead of `npx -y uol-mcp`.

## Development

```bash
npm test                 # unit + MCP-level tests against recorded DEMO responses
npm run typecheck
npm run smoke            # calls every tool against the live DEMO tenant
npm run record-fixtures  # refreshes test/fixtures/demo from the DEMO tenant
bash scripts/build-mcpb.sh  # builds build/uol-mcp.mcpb
docker build -t uol-mcp .
```

Releases are cut by pushing a `v*` tag; `.github/workflows/release.yml` publishes to npm, GHCR,
the GitHub release (MCPB bundle) and the MCP Registry.

Design notes, API facts and the roadmap are in [docs/DESIGN.md](docs/DESIGN.md).

## License

[MIT](LICENSE)
