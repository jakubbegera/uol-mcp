# uol-mcp — design

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server for the
[UOL Účetnictví REST API](https://api.uol.cz/). It lets any MCP client (Claude Desktop / Code,
Cursor, VS Code, Docker MCP Toolkit, …) read a UOL tenant's accounting data and, when explicitly
enabled, write to it.

Unofficial project, not affiliated with UOL a.s.

---

## 1. Goals and non-goals

**Audience**

| Who | Typical question | What they need |
|---|---|---|
| Business owner on UOL | "Kdo mi dluží víc než 30 dní?", "Kolik zaplatím DPH za říjen?" | One-click install, Czech-friendly answers, read-only safety |
| Accountant with several UOL tenants | "Které klientské firmy mají nezpracované doklady?" | Multi-tenant profiles |
| Developer building an agent | "Create the invoice for order 1234" | Write tools, HTTP transport, Docker |

**Goals**

- Cover every read endpoint of the API (curated tools + a read-only escape hatch).
- Encode the API knowledge the spec does not contain (§2). This is the main value over a
  generated 1:1 wrapper.
- Domain-level "insight" tools (revenue/expenses, VAT, receivables) that match UOL's own web dashboard.
- Read-only by default; writes opt-in; destructive operations opt-in separately.
- Distribution that reaches non-developers, not just people with Docker (§7).

**Non-goals for now**

- A hosted multi-user SaaS (see §8).
- Dedicated tools for every write endpoint (petty cash, bank movements, internal documents stay
  reachable via the generic request tool in `full` mode).

---

## 2. API knowledge the spec does not carry

The OpenAPI spec (`https://api.uol.cz/openapi.yaml`, currently **1.0.5**) describes requests well, but
most responses are `application/json: {}` with no schema. The facts below were verified against live
tenants (including the public DEMO tenant) or come from the 1.0.5 spec text. Each one ends up in the
code, in a tool description, or in the server instructions.

| # | Fact | Consequence for the server |
|---|---|---|
| 1 | Amounts are strings (`"1210.0"`). | Normalise to numbers + currency code. |
| 2 | Invoice `status`: `valid` = draft (koncept), `confirmed` = issued, `invalid` = cancelled (storno). Accounting records: `valid` = **posted**. Same word, opposite meaning. | Decode into explicit enums (`draft / issued / cancelled`, `posted`); keep the raw value. |
| 3 | Payment status exists **only** in `/v1/receivables`, and that endpoint covers **sales invoices only**: `invoice_type` is `N` (standard), `Z` (proforma) or `D` (corrective, negative amounts). Purchase invoice ids use the same year-based sequence, so a receivable must never be matched against a purchase invoice. Server-side `state=unpaid\|paid\|all` filter. | Payment status is shown for sales invoices only; purchase tools say plainly that the API has none. |
| 4 | Rate limit: 30 req / 10 s, and `/receivables` 10 req / 10 s. Exceeding it returns 429 for 30 s. | Client-side sliding-window limiter per class, a little below UOL's numbers; receivables snapshot cached for 60 s. |
| 5 | `/purchase_invoices` silently ignores `issue_date_from`; `tax_payment_date_from` (DUZP) works. | Purchase date filters are DUZP / received date only. |
| 6 | `/my_companies` returns dated revisions; the current one is `status=valid`, `valid_to=null`, latest `valid_from`. `vat_payer_code` (undocumented): `M` monthly, `K` quarterly, null = not a VAT payer. | `get_company` resolves the current revision and decodes the VAT period. |
| 7 | `/bank_balances` holds **monthly opening-balance snapshots** (1st of the month), not live balances. | Always return `as_of`; sum the newest snapshot per account, one currency at a time. |
| 8 | Counterparties come as `_meta.href` → `/v1/contacts/{slug}`. | Resolve slug → name through a short-lived cache, capped per call. |
| 9 | Sales invoice PDF / ISDOC: the same detail route with `Accept: application/pdf` or `text/isdoc`. Exactly one `Accept` value; a list falls back to JSON. ISDOC on a non-confirmed invoice → 422. Purchase invoices have no PDF route. | `export_sales_invoice` sends a single `Accept` and checks the response `Content-Type`. |
| 10 | Uploaded-document `file` has three shapes: canonical API route (Basic auth), a tenant-relative `/customers/…` path (Basic auth), an S3 pre-signed URL (**no** auth header). The original filename exists only in `Content-Disposition` (`HEAD` works). UOL periodically deletes PDFs but keeps the record → 404. | One download routine for all three shapes; sanitise the filename; explain a 404. |
| 11 | `document_pairings[].document_pairable_id` is the target's **`gid`**, not the invoice number; there is no filter by `gid`. | Pairings are returned as type + gid; resolving them to invoice numbers would mean scanning lists. |
| 12 | Upload works as multipart binary even though the spec says base64. Failures return `{"message":"Validation failed","errors":[{"field","code"}]}`, e.g. `"It's already uploaded. (43)"`. | Parse the envelope and surface `errors[].code` verbatim. |
| 13 | `/internal_documents` has no date filter. UOL auto-creates a confirmed doc per VAT period with `note = "DPH YYYY/MM"` whose `Vstup …%` / `Výstup …%` lines are the final VAT totals. | The VAT tool prefers the closing doc and falls back to invoice VAT sums (flagged "preliminary"). |
| 14 | General-ledger revenue / expenses = credit class 6xx / debit class 5xx on posted `/accounting_records`, already net of VAT. This is what UOL's web dashboard shows; invoice sums miss rent, payroll, FX. | `get_financial_overview` reads the journal, not invoices. |
| 15 | Booleans in POST bodies must be sent as strings. | Serialise in the client layer, not in tool schemas. |
| 16 | **1.0.5:** `idempotency_key` on sales/purchase invoice create; retrying with the same key fails validation instead of creating a duplicate; it is filterable. | Every create tool sends a generated key and returns it; retries are safe. |
| 17 | **1.0.5:** confirmed invoices cannot be PATCHed (403). `POST /v1/repairs` with `method: cancel` (storno) or `disconfirm`; needs the `cancel` flag on the user's `prodej` membership, fails with 422 for locked periods or bound payments. | `update_*` explains the 403; repairs are destructive tools (§4.3). |
| 18 | **1.0.5:** `created_at_from/to` accept RFC 3339 with offset (`+` must be `%2B`) or a date (start of day, Europe/Prague); anything else → 400. `taxable_person` replaces `business_entity`. Enums for `payment_method` and invoice `type`. | Build query strings with a URL encoder; expose the enums in schemas. |
| 19 | **1.0.5:** `uploaded_client` mentions documents "uploaded with an OIDC token" (`azp` claim). UOL runs an OIDC issuer, but the only documented scheme for API clients is Basic auth. | Basis for a proper remote/OAuth option (§8). |
| 20 | A missing permission answers 401 with code `0002`, the same as bad credentials (seen on `/uploaded_document_tags`). | Error text mentions both causes; optional sub-requests (tags) degrade to null. |
| 21 | Corrective invoices (`type: corrective`, dobropis) carry **positive** `total_amount` and VAT on the invoice endpoints; only `/receivables` shows them negative. | The invoice-based VAT estimate subtracts them. |
| 22 | Ledger rows have `amount` in the document currency and `accounting_amount` in the home currency. `credit_account` / `debit_account` filters match by **prefix** (`6` → every 6xx account). | Aggregate `accounting_amount`; read revenue and expenses with four filtered queries instead of the whole journal. |
| 23 | Year-end closing entries move class 5 / 6 balances to class 7 (e.g. 710). | Postings against class 7 are excluded from revenue / expense sums. |
| 24 | A pairing is created with the target's `gid`; invoices expose it on their detail, petty-cash documents in their list. | `pair_uploaded_document` takes an invoice_id and resolves the gid itself. |
| 25 | Bank movements carry their date only on their parts (`items[].date`), and the list has no date filter. | The movement row takes the date of its first part. |
| 26 | Purchase-invoice lines are written as line totals (`total_price` / `total_price_vat_inclusive`), sales-invoice lines as unit prices. | The two create tools use different item shapes on purpose. |
| 27 | Every invoice line needs an existing `product_id` ("product: must exist; can't be blank"), on sales and purchase invoices alike — verified on DEMO. | `product_id` is required in both create tools; products are listed by `list_codebook kind=products`. |
| 28 | A received invoice paid by bank transfer (the default) needs the supplier's account and a variable symbol. A domestic account number (`123/0800`) is only parsed together with `bank_country_id`; an IBAN works alone. | The tool checks both before sending and adds `bank_country_id` (default CZ) for non-IBAN numbers. |
| 29 | A payment demand needs the customer's `contact_id`, although the spec does not mark it required. | Taken from the checked invoices (they must share one customer). |
| 30 | The pairing POST answers with the document but without the new pairing. | `pair_uploaded_document` reads the document back. |
| 31 | Missing rights answer 403 with code `0014` (the DEMO user can't repair invoices); a duplicate upload answers 400. | Both are explained in the tool error. |
| 32 | The DEMO tenant's credentials are public, so its rate limit is shared with everyone using them; 429 can appear even below our own budget. | Expected on DEMO only. |
| 33 | Some real tenants answer 404 on `/v1/internal_documents` (seen on a sole trader's tenant whose ledger and invoices work), and there is no chart-of-accounts endpoint. A 404 without a body carries no message. | VAT falls back to invoice estimates for every period and says so; account names come from a fixed table of common synthetic accounts; bare HTTP errors name the API path. |
| 34 | UOL's VAT report puts a received invoice's input VAT in the period of the later of its DUZP and `date_of_receipt` (an invoice dated 30 June and received 2 July is deducted in July); the API has no separate deduction-date field. Closing documents carry whole crowns, the web report shows hellers. | The invoice estimate buckets purchases by that later date and queries purchases both by DUZP and by receipt date, so late arrivals from before the window are not lost. |
| 35 | `/v1/sales_invoices` lists drafts (`valid`) and cancelled invoices (`invalid`) together with issued ones; the spec has no status filter. Own bank accounts carry an undocumented `officially_published` flag. | Tools return `status` on every row; the skill checks it for duplicates and reads the flag before large invoices. |

Error codes from the spec: `0001` missing auth, `0002` bad credentials or missing permission,
`0003` unknown tenant, `0004` not found, `0005` cannot delete (integrity), `0010` internal error.

---

## 3. Architecture

### 3.1 Language and SDK

TypeScript with the official SDK v2 (`@modelcontextprotocol/server`), which implements MCP spec
**2026-07-28** and still serves clients that use the older handshake-based revisions. TypeScript
gives `npx` zero-install runs and MCPB bundles that run on the Node runtime shipped with Claude
Desktop — the two paths that reach non-developers.

### 3.2 Transports

- **stdio** (default) — the local process; credentials from env.
- **Streamable HTTP** (`--http` or `MCP_TRANSPORT=http`, endpoint `/mcp`, plus `/health`) — for
  self-hosting (Docker, Railway, Coolify). Built on the SDK's `createMcpHandler`, which serves
  2026-07-28 requests and falls back to stateless serving for 2025-era clients. Every request gets
  a fresh `McpServer`; only the per-user context (HTTP client, rate limiter, caches) is reused. Two
  credential modes, picked from the configuration:
  - *single-tenant*: UOL credentials in the server env; `MCP_AUTH_TOKEN` bearer is **required**
    (the server refuses to start without it) and `X-UOL-*` headers are rejected with 400;
  - *pass-through*: no credentials in the env; every request sends `X-UOL-Tenant`, `X-UOL-Email`,
    `X-UOL-Token` (the DEMO tenant needs only the first) and the server stores nothing. Contexts are
    kept per credential hash (at most 100, idle 30 minutes) so each user keeps their own rate-limit
    budget. Works in clients with custom headers (Claude Code, Cursor, VS Code), not in claude.ai
    connectors (OAuth only, §8). `MCP_AUTH_TOKEN` is optional here.
- HTTP binds to `127.0.0.1` by default. On a loopback bind only localhost `Host` headers are
  accepted (DNS-rebinding protection); elsewhere `MCP_ALLOWED_HOSTS` restricts them. Browser
  `Origin`s must be localhost unless listed in `MCP_ALLOWED_ORIGINS`. The bearer token is compared
  in constant time.
- Over HTTP the server's disk is out of the client's reach, so export / download tools return the
  file embedded in the result (`file_path: null`) instead of saving it.

### 3.3 Configuration

| Variable | Default | Meaning | Since |
|---|---|---|---|
| `UOL_TENANT` | — | `demo`, a tenant name (`firma` → `https://firma.ucetnictvi.uol.cz`), a host prefix (`firma.sandbox`) or a full `https://….uol.cz` URL. Only `*.uol.cz` over HTTPS is accepted. | 0.1 |
| `UOL_EMAIL`, `UOL_TOKEN` | — | Basic-auth credentials (token from UOL → `/api_tokens`). Optional with `UOL_TENANT=demo`. | 0.1 |
| `UOL_DOWNLOAD_DIR` | `~/Downloads/uol-mcp` (temp dir if there is no Downloads folder) | Where export/download tools save files | 0.1 |
| `UOL_TIMEOUT_MS` | `30000` | Per-request timeout | 0.1 |
| `UOL_DEBUG` | off | Request log on stderr (path, status, duration; never credentials) | 0.1 |
| `UOL_ACCESS` | `read` | `read` · `write` (adds upload / create / update) · `full` (adds deletes, repairs and `api_request`) | 0.3 |
| `UOL_TOOLSETS` | `core,insights` | Tool groups to register (§4): `core`, `insights`, `ledger`, `banking`, `warehouse`, or `all`. Unknown names are reported on stderr. | 0.2 |
| `UOL_UPLOAD_DIRS` | `~/Downloads:~/Desktop:~/Documents` (stdio); none over HTTP | Directories `upload_document` may read from; over HTTP, `file_path` is off unless this is set | 0.3 |
| `UOL_AUDIT_LOG` | — | JSONL file recording every write (tool, endpoint, payload hash, result id) | 0.3 |
| `UOL_ACCOUNTS` | — | Several tenants from the environment: `a,b` plus `UOL_ACCOUNT_<NAME>_TENANT`, `_EMAIL`, `_TOKEN`, `_LABEL` (name upper-cased, `-` → `_`); `UOL_DEFAULT_ACCOUNT` or the first is the default; `UOL_ACCOUNT_<NAME>_ACCESS` (0.5) gives one account its own level. Fits hosts whose config is an env block, and `op run` resolving each token from an `op://` reference. Same tools as with a profiles file. | 0.4 |
| `UOL_PROFILES_FILE` | — | JSON with several tenants (`accounts`, `default`; per account `tenant`, `email`, `token` or `token_env`, `label`). Adds `list_accounts` and, with more than one account, an `account` argument to every tool; each account keeps its own rate limiter. Replaces `UOL_TENANT`/`UOL_EMAIL`/`UOL_TOKEN`. A file with inline tokens that others can read is reported. | 0.4 |
| `MCP_TRANSPORT` | `stdio` | `http` starts the HTTP transport (same as `--http`) | 0.3 |
| `MCP_AUTH_TOKEN`, `PORT`, `HOST` | —, 3000, 127.0.0.1 | HTTP mode | 0.3 |
| `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` | localhost names | Accepted `Host` / browser `Origin` hostnames, comma-separated | 0.3 |

The server **starts and lists tools without credentials**: registries and the Docker catalog
introspect `tools/list` that way. A tool call without credentials returns a setup message.
`uol-mcp doctor` checks the credentials and prints the resolved company.

### 3.4 Module layout

```
src/
  index.ts              CLI: stdio | --http | doctor | --version
  http.ts               Streamable HTTP transport: modes, bearer, Host / Origin checks, /health
  server.ts             builds the McpServer and registers tools per toolset and access level
  instructions.ts       server instructions: the domain hints from §2 for the model
  resources.ts          uol://guide, uol://company
  prompts.ts            Czech workflow prompts
  config.ts             env → validated config, tenant resolution
  uol/
    http.ts             fetch wrapper: Basic auth, single Accept, timeout, correlation id,
                        debug log on stderr, Content-Disposition parsing
    rate-limit.ts       sliding-window buckets (general, receivables), FIFO per bucket
    errors.ts           UOL codes 0001–0010 + validation envelope → UolApiError
    client.ts           one method per endpoint, raw response shapes
    normalize.ts        amounts, refs, enums, pagination
  domain/
    company.ts          current company revision
    contact-names.ts    slug → name cache
    receivables.ts      unpaid snapshot, payment status, per-currency totals
    ledger.ts           revenue / expenses per month from the general ledger
    vat.ts              filing periods, closing document vs invoice estimate
    bank.ts             newest balance snapshot per account, totals per currency
    paging.ts           bounded multi-page reads
    files.ts            safe file names, saving downloads
    uploads.ts          reading upload files: allowed folders, PDF check, size cap
    audit.ts            JSONL audit log of writes
  tools/                one module per area: register…Tools(server, ctx); writes*.ts for UOL_ACCESS=write,
                        destructive.ts for full, accounts.ts for UOL_PROFILES_FILE
test/
  fixtures/demo/        raw responses recorded from the DEMO tenant (scripts/record-fixtures.sh,
                        natural persons pseudonymised by scripts/scrub-fixtures.mjs)
  fixtures/synthetic/   hand-written ledger, VAT closing document and bank snapshots
packaging/mcpb/         Claude Desktop bundle manifest (scripts/build-mcpb.sh)
server.json             MCP Registry entry; the release workflow adds the MCPB package
```

### 3.5 Output conventions

- Every tool declares an `outputSchema` and returns `structuredContent`, plus the same data as
  compact JSON in a text block (the spec's recommendation, so clients that ignore structured output
  still see it). Binary results add a `resource_link` to the saved file.
- Amounts are numbers with an ISO currency; dates are ISO; statuses are decoded enums.
- Lists default to 25 rows (max 100) with `page` / `has_more` / `total_pages`. Aggregating tools
  read up to a hard cap (250 rows per page) and report `truncated`; `get_business_snapshot` lists the
  sections cut short in `incomplete`.
- Counterparty names are resolved; ids stay available for follow-up calls. A few names are looked
  up one by one; when more are missing, the contact list (100 per request, hidden contacts included)
  is read first, so a page of 100 invoices with dozens of suppliers still stays inside the rate limit.
- Tool descriptions are English (models handle Czech conversations fine) and carry the domain hints
  from §2: DUZP, status semantics, snapshot semantics.
- `tools/list` order is deterministic.
- Tool names carry no `uol_` prefix: clients namespace by server name (`mcp__uol__…`).

---

## 4. Tool catalogue

### 4.1 Read (default)

| Toolset | Tool | API | Notes |
|---|---|---|---|
| core | `get_company` | `/my_companies` | Name, IČO, DIČ, address, VAT period, tenant. Doubles as a connection check. |
| core | `list_codebook(kind)` | currencies, countries, departments, contracts, price_lists, product_categories, predefined_texts, document_templates, payment_rules, my_bank_accounts, petty_cashes, uploaded_document_tags | One tool instead of twelve. |
| core | `search_sales_invoices` | `/sales_invoices` + receivables snapshot | `query`, buyer, number, variable symbol, type, issue / DUZP / due ranges, total range; payment status per row. |
| core | `get_sales_invoice` | `/sales_invoices/{id}`, `/receivables/{id}` | Items, VAT, payment symbols, payments received, linked invoice. |
| core | `search_purchase_invoices` | `/purchase_invoices` | DUZP / received / due ranges (§2 #5). |
| core | `get_purchase_invoice` | `/purchase_invoices/{id}` | |
| core | `export_sales_invoice(format)` | `Accept: application/pdf \| text/isdoc` | Saves the file; ISDOC XML is also returned as text. |
| core | `list_receivables` | `/receivables` | Unpaid / paid / all, overdue only, customer, date ranges; totals per currency and the invoices, most overdue first. |
| core | `search_contacts` | `/contacts` | Name, IČO, DIČ, country, taxable person. |
| core | `get_contact` | `/contacts/{id}` | Addresses, bank accounts. |
| core | `list_uploaded_documents` | `/uploaded_documents` | State, created range. |
| core | `get_uploaded_document` | `…/{id}/pairings`, `…/{id}/tags`, `HEAD file` | Pairings, tags, original file name. |
| core | `download_uploaded_document` | file (3 shapes) | Saves the file; explains a cleaned-up file. |
| core | `api_get(path, query)` | any `GET /v1/…` | Escape hatch for anything not covered, including future endpoints; output trimmed. |
| insights | `get_financial_overview(months)` | `/accounting_records` (4 prefix-filtered queries) | Revenue / expenses / profit per month from the GL, change vs the previous month, largest accounts with their names; `booked` per month and `booked_through`, so a month the accountant hasn't booked isn't read as zero. |
| insights | `get_vat_overview(periods)` | invoices + `/internal_documents` | Per filing period: output, input, to pay, due date, `preliminary` flag. |
| insights | `get_bank_balances` | `/bank_balances` | Snapshot semantics; newest per account, per currency, optional history. |
| insights | `get_business_snapshot` | all of the above + receivables, documents | This month, VAT, receivables, documents to process, bank balance with `as_of`; failing sections are reported, not fatal. |
| ledger | `search_accounting_records` | `/accounting_records` | Date range, debit / credit account prefix, linked document. |
| ledger | `list_internal_documents` | `/internal_documents` | Read in full (bounded), filtered by date and note text; lines capped per document. |
| banking | `list_bank_movements` | `/bank_movements` | Paging only; parts with their pairings (§2 #25). |
| banking | `list_cash_documents(kind)` | `/petty_cash_incomes`, `/petty_cash_disburstments` | Includes `gid` for pairings. |
| warehouse | `search_products`, `get_product` | `/products` | |
| warehouse | `get_stock_levels` | `/warehouse/statuses` | Quantity and expiry filters. |
| warehouse | `list_orders(kind)` | `/sales_orders`, `/purchase_orders` | Filters for sales orders only. |
| (accounts) | `list_accounts` | — | Only with `UOL_ACCOUNTS` or `UOL_PROFILES_FILE`; never returns credentials. |

All read tools are annotated `readOnlyHint: true, idempotentHint: true, openWorldHint: true`.
`core` + `insights` (the default) register 18 tools; `all` registers 26.

### 4.2 Write (`UOL_ACCESS=write`)

| Tool | API | Safety |
|---|---|---|
| `upload_document(file_path \| content_base64, note)` | `POST /uploaded_documents` (multipart) | The path must resolve (symlinks followed) inside `UOL_UPLOAD_DIRS`; over HTTP, paths are refused unless that variable is set; PDF only (extension and `%PDF-` header); 20 MB cap. A duplicate names the existing document. |
| `create_sales_invoice` | `POST /sales_invoices` | `destructiveHint: true`, since `issue: true` makes the invoice final; draft unless `issue: true`; buyer verified first; `product_id` on every line (§2 #27); auto `idempotency_key` — a repeated key returns the first invoice (`already_existed`); `dry_run` returns the payload without sending |
| `update_sales_invoice` | `PATCH /sales_invoices/{id}` | Drafts only, checked before sending; header fields, `add_items`, `remove_item_ids` (`_destroy`), `issue: true`; only given fields are sent; `destructiveHint: true` |
| `create_contact` | `POST /contacts` | Refuses a second contact with the same IČO unless `allow_duplicate`; address fields form the accounting address |
| `update_contact` | `PATCH /contacts/{id}` | Updates the accounting address by its `address_id` (or adds one); `destructiveHint: true` |
| `create_purchase_invoice` | `POST /purchase_invoices` | Supplier verified first; line totals with `product_id` (§2 #26, #27); bank details checked for bank transfers (§2 #28); unconfirmed unless `confirm: true`; `idempotency_key` with the same recovery as sales invoices |
| `create_payment_demand` | `POST /demands_for_payment` | Every invoice must be an unpaid issued invoice of one customer; `send_by_email` / `send_by_mail` always false |
| `mark_document_processed` | `PATCH /uploaded_documents/{id}` | The only state the API accepts; idempotent |
| `pair_uploaded_document` | `POST …/pairings` | Resolves the target's gid (§2 #24) |
| `tag_uploaded_document`, `untag_uploaded_document` | `POST/DELETE …/tags` | Tag types as enum; untag is `destructiveHint: true` |

### 4.3 Destructive (`UOL_ACCESS=full`)

| Tool | API | Notes |
|---|---|---|
| `delete_sales_invoice` | `DELETE /sales_invoices/{id}` | Drafts only, checked first |
| `repair_sales_invoice(method)` | `POST /repairs` (`document_type: FO`) | Issued invoices only; `cancel` (storno) / `disconfirm` (back to draft); 422 reasons surfaced verbatim |
| `api_request(method, path, body)` | any `/v1` path | Generic write for everything without a dedicated tool |

**Write safety, in layers:** off by default → annotations make the host ask for approval → tool
descriptions tell the model to show the payload and get the user's confirmation → `dry_run` →
idempotency keys → audit log. Invoice texts, document notes and contact names are untrusted input
(prompt-injection vector), which is a further reason to keep writes opt-in; the server instructions
tell the model so. With several accounts, tools are registered for the highest level any account has
and every call checks the level of the account it targets (`UOL_ACCOUNT_<NAME>_ACCESS`).

---

## 5. Resources and prompts

**Resources:** `uol://guide` (tool selection, glossary, synthetic accounts, limits) and `uol://company`.
Planned: `uol://codebooks/{kind}`, templates `uol://sales-invoices/{id}`,
`uol://uploaded-documents/{id}/file`.

**Prompts** (Czech, because the text is sent as the user's message; shown as slash commands; a prompt
is registered only when the toolset it relies on is enabled, and a writing prompt only when the write
tools are registered)

| Prompt | Toolset | Does |
|---|---|---|
| `monthly_review` | insights | Month in numbers: revenue / expenses / profit, VAT, receivables, unprocessed documents |
| `vat_check` | insights | VAT for a period, whether it is preliminary, which documents may still change it |
| `overdue_followup` | core | Overdue receivables grouped by customer, with polite reminder drafts (never sends anything) |
| `process_inbox` | core | Walks unprocessed uploaded documents and suggests matching purchase invoices |
| `issue_invoice` | core + write access | Builds a sales invoice from free text: finds the buyer (`search_contacts`) and an existing product for every line (§2 #27), never invents either, runs `create_sales_invoice` as a dry run, shows a summary with totals and dates and waits for confirmation; then creates a draft (issues only on explicit request, reusing the dry run's idempotency key) and offers the PDF. With several accounts it takes `ucet` and passes it on as `account` |

---

## 6. Security and privacy

- **Credentials:** env vars, MCPB `user_config` fields marked `sensitive`, or Docker MCP Toolkit
  secrets. Never echoed in tool output or logs; logs go to stderr only.
- **Tenant pinning:** only `https://*.uol.cz` API roots are accepted, so a typo or a hostile config
  cannot send the credentials elsewhere. Foreign download URLs (S3) are fetched without them.
- **Least privilege:** use a dedicated UOL user with the *REST API* permission and only the
  memberships needed. Read-only access by default.
- **Ids and paths:** ids are validated (numbers or ASCII slugs) before they become a URL path segment,
  so a model-supplied `..` can't turn one endpoint into another; `api_get` / `api_request` paths
  refuse schemes, hosts, `..` and `%`.
- **Files:** downloads are written only to `UOL_DOWNLOAD_DIR` under sanitised names (fallback names
  built from ids included), never over an existing file, readable by the owner only; uploads are
  restricted to allowed directories, the PDF type and 20 MB.
- **HTTP mode:** bearer token of at least 32 characters (constant-time compare), required in
  single-tenant mode and on any non-loopback bind, which also needs `MCP_ALLOWED_HOSTS`; localhost bind
  by default; `Host` and `Origin` checks; no CORS; no file-path uploads unless `UOL_UPLOAD_DIRS` is set;
  per-credential contexts (least recently used evicted first) so caches never cross tenants; downloads
  capped at 50 MB. Plain HTTP — TLS belongs to a reverse proxy.
- **Data protection:** accounting data contains personal data (natural-person contacts, employees).
  The data goes to whatever model the user's MCP client runs; the user decides (business plans
  without training, local models, …).
- **Supply chain:** three runtime dependencies; npm trusted publishing with provenance; actions
  pinned to commit SHAs; release jobs with publishing rights install with `--ignore-scripts` and keep no
  checkout token; publishing waits for approval on the `release` environment and only admins may push
  `v*` tags; `mcp-publisher` verified by checksum. The image is multi-arch with SBOM and provenance,
  built on a digest-pinned base without npm / yarn / corepack.
- **Scanning:** `npm audit` (production: high, all: critical), Trivy on the image, CodeQL
  (`security-extended`), dependency review on pull requests, Dependabot (7-day cooldown), GitHub secret
  scanning with push protection. Vulnerability reports: [SECURITY.md](../SECURITY.md).

---

## 7. Distribution

| # | Channel | Serves | How |
|---|---|---|---|
| 1 | **npm** `uol-mcp` | Claude Desktop / Code, Cursor, VS Code, Windsurf, Codex configs | `npx -y uol-mcp`; `mcpName` in `package.json` for registry verification |
| 2 | **MCPB bundle** on GitHub Releases | Non-developers on Claude Desktop | One-click install with a form for tenant / e-mail / token |
| 3 | **Official MCP Registry** | Discovery: VS Code / GitHub MCP gallery, aggregators | `server.json` listing the npm, OCI and MCPB packages; name `eu.humblecode/uol`; `mcp-publisher publish` from CI |
| 4a | **Image** `ghcr.io/jakubbegera/uol-mcp` | Self-hosting, HTTP mode | Multi-arch (amd64 / arm64); `LABEL io.modelcontextprotocol.server.name` = registry name |
| 4b | **Docker MCP Catalog** → `mcp/uol` on Docker Hub | Docker Desktop MCP Toolkit users | `servers/uol/server.yaml` in [docker/mcp-registry](https://github.com/docker/mcp-registry); Docker builds, signs and publishes the image. The public DEMO tenant serves as test credentials. |

**Release pipeline** (GitHub Actions, on tag `v*`):

```
verify (tag = package.json = server.json, commit on main)
  → CI result for the commit (awaited; checks.yml runs only if there is none)
  → approval on the "release" environment
      → npm publish --provenance              (skipped if the version exists)
      → docker buildx (amd64, arm64) → ghcr.io
      → GitHub Release + uol-mcp.mcpb         (built without write access; never overwritten)
  → server.json + mcpb sha256 → mcp-publisher publish   (skipped if the registry has the version)
```

The MCP Registry pins the `.mcpb` SHA-256 per version, so a published tag is never re-pushed: a fix
ships as a new patch version.

---

## 8. Hosted remote server (later, optional)

claude.ai on web and mobile, and ChatGPT, accept only remote connectors with OAuth. Two ways to get
there:

- **A — UOL's own OIDC.** The 1.0.5 spec already references OIDC tokens (§2 #19). If UOL opened its
  issuer to third-party clients, the server would be a pure resource server forwarding the user's
  token, with no credential custody. Cleanest, but depends on UOL.
- **B — our own authorization server.** The user enters tenant + e-mail + token once; the server
  encrypts them into the access / refresh token (JWE with a server key) and stores nothing at rest.
  Client registration via Client ID Metadata Documents (DCR is deprecated in 2026-07-28).
  Credentials still transit the operator's infrastructure, which makes the operator a GDPR processor.

Neither is planned for the first releases.

---

## 9. Testing

- **Unit:** normalisers, tenant resolution, rate limiter (fake clock), error mapping, file names,
  company revisions, receivables.
- **MCP level:** the SDK client over an in-memory transport against a fake `fetch` that replays the
  DEMO fixtures; a `tools/list` snapshot (names, order); every tool called at least once.
- **Live smoke:** `uol-mcp doctor` / a scripted run against DEMO, inside the rate limit.
- **Manual:** MCP Inspector.
- **Evals (later):** Czech questions ("Kdo mi dluží víc než 30 dní?", "Je faktura 2026000123
  zaplacená?") run through a real client before releases.

---

## 10. Roadmap

| Version | Scope |
|---|---|
| **v0.1** | Config, HTTP client + rate limit + errors, `core` read tools, stdio, fixture tests, README (EN + CS), MIT |
| **v0.2** | `insights` tools, resources + prompts, toolsets, MCPB bundle, `server.json`, Docker image, CI and release workflows (publishing waits for the public release) |
| **v0.3** | `upload_document`, `create_sales_invoice`, `update_sales_invoice` with idempotency / dry run / audit log; `UOL_ACCESS`; HTTP transport (single-tenant + pass-through) |
| **v0.4** | Contacts, purchase invoices, payment demands, document workflow; `UOL_ACCESS=full` (delete, repair, generic write); `UOL_PROFILES_FILE`, `UOL_ACCOUNTS`; `ledger`, `banking`, `warehouse` toolsets |
| **v0.4.1** | Security fixes from the first review, complete counterparty names on long lists, CI scans and a gated release ([CHANGELOG](../CHANGELOG.md)) |
| **v0.5** | HTTP hardening (token length, no public bind without token and `MCP_ALLOWED_HOSTS`, LRU contexts, 50 MB download cap); data from UOL marked untrusted in the instructions; per-account access levels |
| next | `issue_invoice` prompt; live tests of repairs, deletes and tags on a tenant with those rights |

---

## References

- UOL API: <https://api.uol.cz/> · spec <https://api.uol.cz/openapi.yaml>
- MCP spec 2026-07-28: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- TS SDK v2: <https://ts.sdk.modelcontextprotocol.io/v2/>
- MCP Registry package types: <https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx>
- MCPB: <https://github.com/modelcontextprotocol/mcpb>
- Docker MCP registry: <https://github.com/docker/mcp-registry/blob/main/CONTRIBUTING.md>
