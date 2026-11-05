# Contributing

Contributions are welcome — bug reports, API quirks you ran into, new tools, docs, translations.
If you use UOL Účetnictví and something doesn't work the way your accountant expects, that is worth
an issue too.

## Before you start

- **Bugs and small fixes:** open a pull request directly, or an issue if you're unsure.
- **New tools or larger changes:** open an issue first and describe the use case, so we can agree on
  the shape (toolset, access level, inputs) before you write the code.
- **Security problems:** don't open a public issue — see [SECURITY.md](SECURITY.md).

## Setup

Node.js 22+ (`.nvmrc`).

```bash
git clone https://github.com/jakubbegera/uol-mcp.git
cd uol-mcp
npm install
npm run typecheck
npm test
```

`npm run dev` starts the server from source; `UOL_TENANT=demo` uses UOL's public DEMO company, so you
don't need an account to try things. `npm run smoke` calls every tool against the live DEMO tenant
(mind the shared rate limit).

Coding agents (and anyone who likes a checklist) will find the project rules condensed in
[AGENTS.md](AGENTS.md).

## Rules of the road

- **Never commit real accounting data.** Tests replay responses recorded from the public DEMO tenant
  (`npm run record-fixtures`); the scrubber pseudonymises natural persons. Don't add fixtures from your
  own tenant, and keep tokens, tenant names and personal details out of code, tests and commit messages.
- **Tests come with the change.** Every tool is exercised through a real MCP client against the fake
  UOL API in `test/support/fake-uol.ts`. Structure tests as arrange / act / assert.
- **Writes stay safe.** Anything that changes data needs `UOL_ACCESS=write` (or `full` if it can't be
  undone), a `dry_run`, the right annotations (`destructiveHint` etc.) and an audit-log entry.
- **Credentials only go to `https://*.uol.cz`.** Don't add code paths that could send them elsewhere,
  log them or return them in tool output.
- **API facts go into [docs/DESIGN.md](docs/DESIGN.md) §2** — if you learned something the OpenAPI spec
  doesn't say, write it down there with how you verified it.
- **Match the surrounding code**: TypeScript strict mode, zod schemas for inputs and outputs, English
  identifiers, comments and tool descriptions (the model handles Czech conversations fine). User-facing
  prompts stay Czech.

### Adding a tool

1. Pick the toolset (`core`, `insights`, `ledger`, `banking`, `warehouse`) or the access level for writes.
2. Declare `input` and `output` schemas; return compact, normalised data (amounts as numbers, decoded
   statuses, resolved counterparty names); page lists or report `truncated`.
3. Add tests, then update the tool tables in [README.md](README.md), [README.cs.md](README.cs.md) and [docs/DESIGN.md](docs/DESIGN.md),
   the tool list in `packaging/mcpb/manifest.json`, and [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.

## Pull requests

- Keep a PR to one topic; describe what changed and why.
- Commit messages are English, imperative, with an area prefix: `Invoices: resolve every counterparty name`.
- CI must pass: type check, tests, `npm audit`, the Docker build with a Trivy scan, CodeQL, and
  dependency review. A new runtime dependency needs a good reason — the server deliberately has three.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under *Unreleased* for anything a user would notice.
- `README.cs.md` is a shorter Czech guide that links to `README.md` for the details; when a change touches
  what it covers (setup, writing, several companies, privacy), update it too and keep its links working.

By contributing you agree that your work is released under the [MIT License](LICENSE).
