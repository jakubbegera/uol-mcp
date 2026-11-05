# AGENTS.md

Guidance for coding agents working in this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md);
everything here applies to you too.

## What this is

`uol-mcp` is an MCP server for the UOL Účetnictví REST API (Czech online accounting), written in
TypeScript on the official MCP SDK v2 (`@modelcontextprotocol/server`), zod for schemas and vitest for
tests. Node.js 22+ (`.nvmrc`), ESM (`"module": "nodenext"`, imports end in `.js`). It ships as an npm
package, a GHCR image, a Claude Desktop bundle (`.mcpb`) and an MCP Registry entry (`eu.humblecode/uol`).

Read [docs/DESIGN.md](docs/DESIGN.md) before changing behaviour — §2 lists the API facts the OpenAPI
spec doesn't tell you (status `valid` means *draft*, receivables are sales-only, ledger amounts, …).

## Commands

```bash
npm ci --ignore-scripts      # install (CI does the same)
npm run typecheck            # tsc --noEmit over src and test
npm test                     # vitest: unit + MCP-level tests against the fake UOL API
npm run build                # dist/
npm run dev                  # run the server from source (stdio); UOL_TENANT=demo needs no token
npm run smoke                # every tool against the live public DEMO tenant (shared rate limit)
bash scripts/build-mcpb.sh   # build/uol-mcp.mcpb
docker build -t uol-mcp .
```

Before you finish: `npm run typecheck && npm test` must pass. CI also runs the tests on Node 22, 24
and 26, `npm audit`, a Trivy scan of the image, CodeQL and dependency review.

## Layout

- `src/config.ts` — env and profiles-file parsing, tenant resolution (`https://*.uol.cz` only),
  access levels (`read` < `write` < `full`, per account via `UOL_ACCOUNT_<NAME>_ACCESS`).
- `src/server.ts` — sessions per account and tool registration (by toolset and highest access level).
- `src/http.ts` — Streamable HTTP transport (single-tenant / pass-through, auth and host checks).
- `src/uol/` — HTTP client (`http.ts`: auth, rate limit, download cap), one method per endpoint
  (`client.ts`), error mapping (`errors.ts`), normalisers (`normalize.ts`).
- `src/domain/` — logic without MCP: ledger and VAT aggregation, receivables, paging (`fetchPages`),
  contact-name resolution, file names and downloads (`files.ts`), uploads, audit log.
- `src/tools/` — the tools, grouped by area. `context.ts` holds `registerReadTool`, `registerTool`
  (writes) and `registerFullTool` (deletes, repairs, raw writes); `write-support.ts` holds
  `auditedWrite`, `CONFIRM_FIRST` and the `WRITE` / `DESTRUCTIVE` annotations; `schemas.ts` the shared
  zod pieces (`pageArg`, `limitArg`, `pageInfo`, `isoDate`).
- `src/instructions.ts`, `src/prompts.ts`, `src/resources.ts` — what the model sees besides tools.
- `test/` — `*.test.ts`; `test/support/fake-uol.ts` serves the recorded fixtures through a fake
  `fetch` (`connect(config, fetch)`, `demoConfig()`, `fakeUolFetch()` with the `requests` it saw).
  `test/fixtures/demo/` is recorded from the public DEMO tenant and pseudonymised;
  `test/fixtures/synthetic/` is hand-made.

## Conventions

- English for code, comments, docs and tool descriptions; Czech only for prompts (`src/prompts.ts`) and
  `README.cs.md`.
- Match the surrounding code: small functions, comments that explain *why*, no dead code.
- Every tool declares `input` and `output` zod schemas and returns compact, normalised data: amounts as
  numbers, decoded statuses, resolved counterparty names, ISO dates. Lists page (`pageArg`, `limitArg`,
  `pagination`); summaries read with `fetchPages` and report `truncated`.
- Tool names have no `uol_` prefix; descriptions carry the domain hints a model needs (DUZP, statuses).
- Errors: `InputError` for bad arguments, `ConfigError` for setup problems, `UolApiError` from the API —
  `describeError` turns them into tool errors the model can act on.
- Tests follow arrange / act / assert, each phase headed by a `// arrange`, `// act`, `// assert`
  comment and separated by a blank line; one action per test where possible. New tools get a test
  through the MCP client against the fake API.

## Safety rules (do not relax these)

- Credentials go only to `https://*.uol.cz` (`resolveTenant`); never log them, return them or put them
  in errors. Ids reach URL paths only through `UolClient`'s id check.
- Writes need `UOL_ACCESS=write` (or `full` for anything that can't be undone), a `dry_run`, the right
  annotations, `CONFIRM_FIRST` in the description and `auditedWrite`. Each call is checked against the
  access level of the account it targets.
- Files: downloads through `saveDownload` / `deliverFile` (sanitised names, no overwrite, 50 MB cap);
  uploads through `readUploadFile` (allowed folders only; none over HTTP unless `UOL_UPLOAD_DIRS`).
- Text returned from UOL is untrusted data. Never let it flow into tool descriptions or instructions.
- Never commit real accounting data, tenant names, tokens or personal details — not in code, fixtures,
  tests, docs or commit messages. Refresh fixtures only with `npm run record-fixtures` (DEMO tenant,
  then scrubbed). `README-internal.md`, `build/` and `*.pem` are git-ignored on purpose; keep them so.
- A new runtime dependency needs a strong reason; the server has three.

## When you change something

- New API fact learned → add it to DESIGN §2 with how you verified it.
- New or changed tool → tool tables in `README.md`, `README.cs.md` and DESIGN §4 (and the tool counts
  there), `packaging/mcpb/manifest.json`, and `CHANGELOG.md` under *Unreleased*.
- `README.md` and `README.cs.md` mirror each other section by section; change both.
- New env variable → `src/index.ts` help text, the config tables in both READMEs and DESIGN §3.3.

## Git, CI and releases

- Commit messages: English, imperative, with an area prefix (`Invoices: …`, `HTTP: …`, `CI: …`); the
  body says why. No co-author trailers or tool attribution footers in commits or pull requests.
- Workflow changes go through a pull request. Third-party actions stay pinned to a commit SHA with the
  version in a comment; `checks.yml` is the single definition of the CI checks.
- Releases: bump the version in `package.json`, `package-lock.json` and `server.json` (both `version`
  fields and the GHCR tag), move *Unreleased* in `CHANGELOG.md` under the new version, merge to `main`,
  then push tag `v<version>` on that commit. The release reuses the commit's CI result and waits for
  approval on the `release` environment. Never move or re-push a published tag — the MCP Registry pins
  the `.mcpb` SHA-256; ship a new patch version instead.
- Live tests against the DEMO tenant share its rate limit with everyone (~30 requests / 10 s); never
  write to a real tenant without the owner's explicit go-ahead.
