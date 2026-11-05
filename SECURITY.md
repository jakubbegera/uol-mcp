# Security policy

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/jakubbegera/uol-mcp/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it, and the version (`uol-mcp --version`).

You can expect a first answer within a few days. Fixes ship as a patch release, with the issue
described in [CHANGELOG.md](CHANGELOG.md) once users can update.

## Supported versions

Only the latest release gets security fixes.

## Scope

In scope: the server itself (credential handling, the HTTP transport, file uploads and downloads,
write-access gating), the published packages (npm, GHCR image, `.mcpb` bundle) and the release
pipeline. Problems in the UOL API itself belong to UOL a.s.

How the server protects credentials and data is described in [docs/DESIGN.md](docs/DESIGN.md#6-security-and-privacy).
