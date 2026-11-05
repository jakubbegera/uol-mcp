#!/usr/bin/env bash
# Builds build/uol-mcp.mcpb — a Claude Desktop bundle with the compiled server,
# production dependencies and packaging/mcpb/manifest.json (version taken from
# package.json). Prints the SHA-256 the MCP Registry entry needs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/build/mcpb"
OUT="$ROOT/build/uol-mcp.mcpb"

cd "$ROOT"
npm run -s build

rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE"
cp -R dist package.json package-lock.json LICENSE README.md "$STAGE/"
VERSION="$(node -p 'require("./package.json").version')"
node -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  manifest.version = process.argv[2];
  fs.writeFileSync(process.argv[3], JSON.stringify(manifest, null, 2) + "\n");
' packaging/mcpb/manifest.json "$VERSION" "$STAGE/manifest.json"

(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)
rm "$STAGE/package-lock.json"

npx --no-install mcpb validate "$STAGE/manifest.json"
npx --no-install mcpb pack "$STAGE" "$OUT"
echo "sha256 $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
