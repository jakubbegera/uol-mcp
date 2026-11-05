# uol-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for
[UOL Účetnictví](https://www.uol.cz) — ask Claude, Cursor or any other MCP client about your
bookkeeping: issued and received invoices, who owes you money, uploaded documents, contacts.

> **Unofficial.** Not affiliated with or endorsed by UOL a.s. It talks to the public
> [UOL REST API](https://api.uol.cz/) with your own API token.

[Česky](README.cs.md)

**Status:** v0.6 — read-only by default, opt-in writes. What changed: [CHANGELOG.md](CHANGELOG.md).

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

More read tools are available as opt-in toolsets (`UOL_TOOLSETS`): `ledger` (general-ledger postings, internal
documents), `banking` (bank movements, petty-cash documents) and `warehouse` (products, stock levels, orders).

Ready-made prompts (slash commands in most clients): `monthly_review`, `vat_check`,
`overdue_followup` (drafts reminders, sends nothing), `process_inbox`, and with
[write access](#writing-opt-in) `issue_invoice` (builds a sales invoice from your description, shows a
dry run and creates a draft once you confirm). The `uol://guide` resource explains the domain to the model.

The [`uol-ucetnictvi` skill](skills/uol-ucetnictvi/SKILL.md) goes further: Claude issues an invoice the
way you always invoice that customer (DUZP rule, due days, products, line texts and bank account learned
from your earlier invoices to them) and reads revenue, profit, VAT and receivables the way an
accountant does (unbooked months, estimates, deadlines). Install it in Claude Desktop or claude.ai by
zipping the `skills/uol-ucetnictvi` folder and uploading it under Settings → Capabilities → Skills, or in
Claude Code by copying the folder to `~/.claude/skills/`.

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
| `UOL_TOOLSETS` | Comma-separated: `core`, `insights` (these two are the default), `ledger`, `banking`, `warehouse`, or `all` |
| `UOL_ACCESS` | `read` (default), `write` or `full` — see [Writing](#writing-opt-in) |
| `UOL_ACCOUNTS`, `UOL_DEFAULT_ACCOUNT` | Several companies in one server — see [Several companies](#several-companies); `UOL_ACCOUNT_<NAME>_ACCESS` sets one account's level |
| `UOL_PROFILES_FILE` | The same from a JSON file |
| `UOL_UPLOAD_DIRS` | Folders `upload_document` may read from (default `~/Downloads`, `~/Desktop`, `~/Documents`; `:`-separated, `;` on Windows). The HTTP server has no default: without this variable it accepts only `content_base64` |
| `UOL_AUDIT_LOG` | File that records every write as a JSON line |
| `UOL_TIMEOUT_MS` | Timeout of one UOL request (default `30000`) |
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
MCP_TRANSPORT=http MCP_AUTH_TOKEN=$(openssl rand -hex 32) UOL_TENANT=firma UOL_EMAIL=you@example.com UOL_TOKEN=your-token npx -y uol-mcp
```

The endpoint is `http://127.0.0.1:3000/mcp` (`HOST`, `PORT` to change; `/health` for probes).
Two modes:

- **One tenant**: UOL credentials in the server's env. Clients must send `Authorization: Bearer
  <MCP_AUTH_TOKEN>`; the server refuses to start without the token.
- **Pass-through**: no UOL credentials in the env. Each client sends its own `X-UOL-Tenant`,
  `X-UOL-Email` and `X-UOL-Token` headers with every request; the server stores nothing.
  `MCP_AUTH_TOKEN` is optional on localhost.

Over HTTP, exported invoices and downloaded documents come back inside the tool result instead of
being saved on the server, and `upload_document` takes the file as `content_base64` — it reads no
paths on the server unless `UOL_UPLOAD_DIRS` is set. In Docker, bind to all interfaces and publish the
port: `docker run -p 3000:3000 -e MCP_TRANSPORT=http -e HOST=0.0.0.0 -e MCP_AUTH_TOKEN=… -e MCP_ALLOWED_HOSTS=mcp.example.com …`.

| Variable | Meaning |
|---|---|
| `MCP_TRANSPORT` | `http` starts the HTTP server (same as `--http`) |
| `HOST`, `PORT` | Bind address, default `127.0.0.1:3000` |
| `MCP_AUTH_TOKEN` | Bearer token clients must send, at least 32 characters; required in one-tenant mode and whenever `HOST` is not a loopback address |
| `MCP_ALLOWED_HOSTS` | Accepted `Host` names (comma-separated); required when `HOST` is not a loopback address |
| `MCP_ALLOWED_ORIGINS` | Browser origins allowed to call the endpoint (none by default) |

The server speaks plain HTTP: anywhere beyond localhost, put it behind a reverse proxy that
terminates TLS. The server refuses to start on a non-loopback address without `MCP_AUTH_TOKEN` and
`MCP_ALLOWED_HOSTS`.

### Check the setup

```bash
UOL_TENANT=firma UOL_EMAIL=you@example.com UOL_TOKEN=your-token npx -y uol-mcp doctor
```

## Writing (opt-in)

With `UOL_ACCESS=write` these tools appear:

| Tool | Does |
|---|---|
| `upload_document` | Uploads a PDF to UOL's document inbox for the accountant (only from `UOL_UPLOAD_DIRS`) |
| `create_sales_invoice` | Creates an issued invoice for an existing contact — a draft unless `issue: true` |
| `update_sales_invoice` | Changes or issues a draft invoice (UOL doesn't allow editing issued ones) |
| `create_purchase_invoice` | Books a received invoice from an existing supplier |
| `create_contact`, `update_contact` | Adds or changes a customer / supplier (refuses a duplicate IČO) |
| `create_payment_demand` | Creates a payment demand (upomínka) for unpaid invoices of one customer — never sends it |
| `mark_document_processed`, `pair_uploaded_document`, `tag_uploaded_document`, `untag_uploaded_document` | The accountant's inbox: state, link to the booked record, tags |

`UOL_ACCESS=full` adds `delete_sales_invoice` (drafts only), `repair_sales_invoice` (storno or back to
draft for issued invoices) and `api_request` (a raw write to any endpoint).

Invoice lines need a UOL product (`list_codebook` with `kind: products` lists them). Every write
supports `dry_run` (shows exactly what would be sent), creates are safe to retry
(idempotency key), and the tools are marked so clients ask you before running them. Set
`UOL_AUDIT_LOG` to keep a record of every write.

## Several companies

Accountants with several clients on UOL can serve them all from one server. List the accounts in
`UOL_ACCOUNTS` and give each one its own variables (name upper-cased, `-` becomes `_`):

```json
"env": {
  "UOL_ACCOUNTS": "firma,novak",
  "UOL_ACCOUNT_FIRMA_TENANT": "firma",
  "UOL_ACCOUNT_FIRMA_EMAIL": "ja@firma.cz",
  "UOL_ACCOUNT_FIRMA_TOKEN": "op://Private/UOL firma/credential",
  "UOL_ACCOUNT_NOVAK_TENANT": "novak",
  "UOL_ACCOUNT_NOVAK_EMAIL": "ja@firma.cz",
  "UOL_ACCOUNT_NOVAK_TOKEN": "op://Private/UOL novak/credential",
  "UOL_ACCOUNT_NOVAK_LABEL": "Novák s.r.o."
}
```

The first account is the default (or set `UOL_DEFAULT_ACCOUNT`). With the 1Password CLI, start the
server as `op run -- node …/dist/index.js` and the `op://` references are replaced by the tokens at
startup — nothing secret sits in the config. `uol-mcp doctor` checks every account.

Alternatively, point `UOL_PROFILES_FILE` at a JSON file:

```json
{
  "default": "firma",
  "accounts": {
    "firma": { "tenant": "firma", "email": "ja@firma.cz", "token_env": "UOL_TOKEN_FIRMA" },
    "novak": { "tenant": "novak", "email": "ja@firma.cz", "token_env": "UOL_TOKEN_NOVAK", "label": "Novák s.r.o." }
  }
}
```

`token_env` names an environment variable holding the token, so the file needs no secrets (an inline
`token` works too; keep such a file `chmod 600`). The server then offers `list_accounts`, and every tool
takes an `account` argument — *"Kdo dluží firmě Novák?"* goes to the right tenant. Each account keeps
its own rate limit.

Accounts can have their own access level: with `UOL_ACCESS=write` and `UOL_ACCOUNT_NOVAK_ACCESS=read`
(or `"access": "read"` in the profiles file), writes to Novák are refused while the other account can
still write. `list_accounts` shows each account's level.

## Privacy and safety

- Read-only unless you set `UOL_ACCESS=write`. Text inside invoices, notes and documents is treated
  as data: review what the assistant proposes to write before you approve it.
- Whatever the tools return goes to the AI model your client uses. Accounting data contains personal
  data of your contacts and employees — use a plan whose terms you are comfortable with.
- Credentials are used only for `https://*.uol.cz` and are never written to logs or tool output.
- Downloaded files are saved under `UOL_DOWNLOAD_DIR` only, readable by the owner, and never replace an existing file (a taken name gets a ` (1)` suffix). Downloads over 50 MB are refused.
- The model is told that text coming from UOL (invoices, notes, documents) is data, never instructions.

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

CI runs the type check, tests, `npm audit`, a Trivy scan of the Docker image, CodeQL and, on pull
requests, dependency review; Dependabot keeps dependencies, actions and the base image current.

Releases are cut by pushing a `v*` tag; after a maintainer approves the `release` environment,
`.github/workflows/release.yml` publishes to npm, GHCR, the GitHub release (MCPB bundle) and the MCP
Registry.

Design notes, API facts and the roadmap are in [docs/DESIGN.md](docs/DESIGN.md).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems
privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
