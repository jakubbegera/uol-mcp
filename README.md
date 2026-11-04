# uol-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for
[UOL Účetnictví](https://www.uol.cz) — ask Claude, Cursor or any other MCP client about your
bookkeeping: issued and received invoices, who owes you money, uploaded documents, contacts.

> **Unofficial.** Not affiliated with or endorsed by UOL a.s. It talks to the public
> [UOL REST API](https://api.uol.cz/) with your own API token.

[Česky](README.cs.md)

**Status:** v0.1 — read-only. Not on npm yet; run it [from source](#from-source) until the first release.

## What it can do

| Tool | Answers |
|---|---|
| `get_company` | Company name, IČO, DIČ, address, VAT filing period; doubles as a connection check |
| `search_sales_invoices`, `get_sales_invoice` | Issued invoices with line items, VAT and payment status |
| `search_purchase_invoices`, `get_purchase_invoice` | Received invoices |
| `list_receivables` | Who owes you, how much, how long overdue — totals per currency |
| `export_sales_invoice` | PDF or ISDOC of an issued invoice, saved to disk (ISDOC is also returned as XML) |
| `search_contacts`, `get_contact` | Customers and suppliers by name, IČO or DIČ, with addresses and bank accounts |
| `list_uploaded_documents`, `get_uploaded_document`, `download_uploaded_document` | Documents uploaded for the accountant, their state and files |
| `list_codebook` | Currencies, departments, contracts, price lists, own bank accounts, … |
| `api_get` | Read-only GET of any other `/v1/…` endpoint |

Example questions: *"Kdo mi dluží víc než 30 dní?"*, *"Je faktura 2026000123 zaplacená?"*,
*"Kolik jsme letos fakturovali firmě Alza?"*, *"Stáhni mi PDF poslední vydané faktury."*

The server knows the API's quirks: invoice status `valid` means *draft*, payment status exists only
for issued invoices, purchase invoices ignore issue-date filters, files have three different
download shapes, and the rate limit (30 requests / 10 s) is respected client-side. See
[docs/DESIGN.md](docs/DESIGN.md).

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

### Check the setup

```bash
UOL_TENANT=firma UOL_EMAIL=you@example.com UOL_TOKEN=your-token npx -y uol-mcp doctor
```

## Privacy and safety

- v0.1 only reads. Write tools (uploading documents, issuing invoices) will be opt-in and off by default.
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
```

Design notes, API facts and the roadmap are in [docs/DESIGN.md](docs/DESIGN.md).

## License

[MIT](LICENSE)
