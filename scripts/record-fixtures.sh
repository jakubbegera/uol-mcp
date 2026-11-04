#!/usr/bin/env bash
# Records raw responses from the public UOL DEMO tenant into test/fixtures/demo.
# The tests replay these files, so re-run this script when the API changes and
# review the diff. Requests are spaced out to stay well inside the rate limit
# (30 requests / 10 s, receivables 10 / 10 s).
set -euo pipefail

BASE="https://test.demo.uol.cz/api"
AUTH="demo@ucetnictvi-on-line.cz:3R1Cc_wzcSuq02Wsh1-uww"
OUT="$(cd "$(dirname "$0")/.." && pwd)/test/fixtures/demo"
mkdir -p "$OUT"

# record <name> <path+query>
record() {
  local name="$1" path="$2" code
  code=$(curl -s -m 30 -u "$AUTH" -H 'Accept: application/json' -o "$OUT/$name.json" -w '%{http_code}' "$BASE$path")
  printf '%-36s %s %6s bytes\n' "$name" "$code" "$(wc -c < "$OUT/$name.json" | tr -d ' ')"
  sleep 0.6
}

# Pretty-prints a recorded file in place so diffs stay reviewable.
pretty() {
  local f="$OUT/$1.json"
  node -e 'const fs=require("fs");const f=process.argv[1];try{fs.writeFileSync(f,JSON.stringify(JSON.parse(fs.readFileSync(f,"utf8")),null,2)+"\n")}catch{}' "$f"
}

first_id() { # first_id <file> <field>
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(d.items||[])[0]?.[process.argv[2]];if(v!=null)process.stdout.write(String(v))' "$OUT/$1.json" "$2"
}

record ping                    "/v1/ping"
record my_companies            "/v1/my_companies"
record sales_invoices          "/v1/sales_invoices?per_page=5&page=1"
record purchase_invoices       "/v1/purchase_invoices?per_page=5&page=1"
record receivables             "/v1/receivables?per_page=100"
record contacts                "/v1/contacts?per_page=5"
record uploaded_documents      "/v1/uploaded_documents?per_page=5"
record currencies              "/v1/currencies?per_page=5"
record countries               "/v1/countries?per_page=3"
record departments             "/v1/departments?per_page=5"
record my_bank_accounts        "/v1/my_bank_accounts"
record uploaded_document_tags  "/v1/uploaded_document_tags"
record err_404_sales_invoice   "/v1/sales_invoices/9999999999"

SI=$(first_id sales_invoices invoice_id)
PI=$(first_id purchase_invoices invoice_id)
CT=$(first_id contacts contact_id)
UD=$(first_id uploaded_documents id)
[ -n "$SI" ] && record sales_invoice_detail        "/v1/sales_invoices/$SI"
[ -n "$PI" ] && record purchase_invoice_detail     "/v1/purchase_invoices/$PI"
[ -n "$CT" ] && record contact_detail              "/v1/contacts/$CT"
[ -n "$CT" ] && record contact_bank_accounts       "/v1/contact_bank_accounts?contact=$CT"
[ -n "$UD" ] && record uploaded_document_detail    "/v1/uploaded_documents/$UD"
[ -n "$UD" ] && record uploaded_document_pairings  "/v1/uploaded_documents/$UD/pairings"
[ -n "$UD" ] && record uploaded_document_doc_tags  "/v1/uploaded_documents/$UD/tags"

code=$(curl -s -m 30 -u "x@example.com:bad" -o "$OUT/err_401.json" -w '%{http_code}' "$BASE/v1/ping")
printf '%-36s %s\n' err_401 "$code"

for f in "$OUT"/*.json; do pretty "$(basename "$f" .json)"; done

node "$(dirname "$0")/scrub-fixtures.mjs" "$OUT"
