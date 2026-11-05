# Changelog

All notable changes to uol-mcp. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.4] — 2026-11-05

0.4.3 was tagged but never published: its release run skipped every publishing job (fixed below).

### Changed

- The checks live in one reusable workflow (`checks.yml`). A release no longer re-runs them: it
  requires the tagged commit to be on `main` with a passing CI run, and runs the checks itself only
  when no CI result exists.

### Fixed

- Publishing jobs no longer get skipped when the release reuses the CI result (a skipped job
  upstream skipped everything after it).

## [0.4.2] — 2026-11-05

### Changed

- The Docker image runs on Node.js 26 (LTS); CI tests every supported line (22, 24, 26).
- Releases wait for npm to serve a new version before publishing it to the MCP Registry.

## [0.4.1] — 2026-11-05

### Security

- Ids are validated before they go into a URL path. `..` used to pass, so
  `untag_uploaded_document(tag_id="..")` became `DELETE /uploaded_documents/<id>/` — a tag removal
  that deleted the whole document.
- The HTTP server no longer reads `file_path` uploads from its own disk unless `UOL_UPLOAD_DIRS` is set
  explicitly; remote callers send `content_base64`.
- Download file names built from ids are sanitised too; downloads never replace an existing file
  (a taken name gets a ` (1)` suffix) and are saved readable by the owner only.
- An invalid `UOL_PROFILES_FILE` is reported without quoting the file, which could contain a token.
- The Docker image no longer ships npm, yarn and corepack (the server needs only node), and the base
  image is pinned by digest.
- Release workflow hardened: publishing waits for approval on the `release` environment, actions are
  pinned to commit SHAs, jobs with publishing rights don't run dependency install scripts, the
  `mcp-publisher` download is checked against its release checksum, and an existing release asset is
  never overwritten.
- CI scans: `npm audit`, Trivy (image), CodeQL, dependency review on pull requests, Dependabot.

### Fixed

- Supplier and customer names were missing on long invoice lists: names were looked up one contact
  at a time, at most 15 per call. Long lists now read the contact list first.
- `get_business_snapshot` lists sections that were read only partly in `incomplete`, and
  `get_bank_balances` returns `truncated`, as the other summaries already did.

## [0.4.0] — 2026-11-05

First public release (0.1–0.3 were internal milestones).

### Added

- **Read tools** (default): company, codebooks, sales and purchase invoices with payment status,
  receivables with totals per currency, PDF / ISDOC export, contacts, uploaded documents, `api_get`.
- **Insights**: financial overview from the general ledger, VAT per filing period, bank balances, and a
  one-call business snapshot.
- **Optional toolsets** (`UOL_TOOLSETS`): `ledger`, `banking`, `warehouse`.
- **Writes** (`UOL_ACCESS=write`): document upload, sales invoices (draft by default, idempotent),
  purchase invoices, contacts, payment demands, the uploaded-document workflow; every write supports
  `dry_run` and can be recorded in `UOL_AUDIT_LOG`.
- **Destructive tools** (`UOL_ACCESS=full`): delete a draft, storno / back to draft, `api_request`.
- **Several companies**: `UOL_ACCOUNTS` (all in the client config) or `UOL_PROFILES_FILE`;
  `list_accounts` and an `account` argument on every tool.
- Czech prompts (`monthly_review`, `vat_check`, `overdue_followup`, `process_inbox`) and the
  `uol://guide` / `uol://company` resources.
- Streamable HTTP transport: single-tenant with a bearer token, or pass-through with per-request
  credentials.
- `uol-mcp doctor` checks the configuration (every account).
- Distribution: npm, GHCR image (amd64 / arm64), Claude Desktop extension (`.mcpb`), MCP Registry
  (`eu.humblecode/uol`).

[Unreleased]: https://github.com/jakubbegera/uol-mcp/compare/v0.4.4...HEAD
[0.4.4]: https://github.com/jakubbegera/uol-mcp/compare/v0.4.2...v0.4.4
[0.4.2]: https://github.com/jakubbegera/uol-mcp/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/jakubbegera/uol-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jakubbegera/uol-mcp/releases/tag/v0.4.0
