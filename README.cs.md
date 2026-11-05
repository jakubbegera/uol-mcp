# uol-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server pro
[UOL Účetnictví](https://www.uol.cz): ptejte se Claude, Cursoru nebo jiného MCP klienta na své
účetnictví — vydané a přijaté faktury, kdo vám dluží, nahrané doklady, kontakty.

> **Neoficiální projekt.** Není spojený s UOL a.s. ani jím schválený. Komunikuje s veřejným
> [UOL REST API](https://api.uol.cz/) pomocí vašeho vlastního API tokenu.

[English](README.md)

**Stav:** v0.4 — ve výchozím stavu jen čtení, zápis lze zapnout. Změny jednotlivých verzí:
[CHANGELOG.md](CHANGELOG.md).

## Co umí

| Tool | Odpovídá na |
|---|---|
| `get_business_snapshot` | Jak si firma stojí, jedním dotazem: tento a minulý měsíc, DPH, pohledávky, doklady ke zpracování, banka |
| `get_financial_overview` | Výnosy, náklady a zisk po měsících z hlavní knihy, největší účty |
| `get_vat_overview` | DPH za zdaňovací období: k zaplacení nebo nadměrný odpočet, termín, konečná částka nebo odhad |
| `get_bank_balances` | Zůstatky podle účtů a měn (UOL eviduje měsíční počáteční stavy) |
| `get_company` | Název firmy, IČO, DIČ, adresa, zdaňovací období DPH; zároveň kontrola připojení |
| `search_sales_invoices`, `get_sales_invoice` | Vydané faktury s položkami, DPH a stavem úhrady |
| `search_purchase_invoices`, `get_purchase_invoice` | Přijaté faktury |
| `list_receivables` | Kdo vám dluží, kolik a jak dlouho po splatnosti — součty podle měn |
| `export_sales_invoice` | PDF nebo ISDOC vydané faktury uložené na disk (ISDOC vrátí i jako XML) |
| `search_contacts`, `get_contact` | Odběratelé a dodavatelé podle názvu, IČO nebo DIČ, s adresami a bankovními účty |
| `list_uploaded_documents`, `get_uploaded_document`, `download_uploaded_document` | Doklady nahrané pro účetní, jejich stav a soubory |
| `list_codebook` | Měny, střediska, zakázky, ceníky, vlastní bankovní účty a další číselníky |
| `api_get` | GET na libovolný další endpoint `/v1/…`, jen pro čtení |

Příklady otázek: *„Jak si letos stojíme?“*, *„Kolik zaplatím DPH za tento kvartál?“*,
*„Kdo mi dluží víc než 30 dní?“*, *„Je faktura 2026000123 zaplacená?“*,
*„Na čem nejvíc utrácíme?“*, *„Stáhni mi PDF poslední vydané faktury.“*

Další nástroje pro čtení jsou ve volitelných sadách (`UOL_TOOLSETS`): `ledger` (zápisy v hlavní knize,
interní doklady), `banking` (bankovní pohyby, pokladní doklady) a `warehouse` (produkty, stav skladu,
objednávky).

Připravené postupy (ve většině klientů jako příkazy s lomítkem): `monthly_review` (měsíční přehled),
`vat_check` (kontrola DPH), `overdue_followup` (návrhy upomínek, nic neodesílá) a `process_inbox`
(projde nahrané doklady). Resource `uol://guide` vysvětluje modelu, jak účetnictví v UOL funguje.

Server zná zvláštnosti API: stav faktury `valid` znamená *koncept*, stav úhrady existuje jen u vydaných
faktur, dobropisy přicházejí s kladnými částkami, výnosy a náklady se musí číst z hlavní knihy (bez
závěrkových zápisů), přijaté faktury ignorují filtr podle data vystavení, soubory mají tři různé způsoby
stažení a limit 30 požadavků za 10 s hlídá server sám. Podrobnosti jsou v [docs/DESIGN.md](docs/DESIGN.md).

## Jak získat API token

1. Otevřete v UOL stránku API tokenů (adresa `/api_tokens` na vaší instanci, např.
   `https://firma.ucetnictvi.uol.cz/api_tokens`) a vytvořte token.
2. Uživatel UOL musí mít oprávnění **REST API**. Doporučujeme samostatného uživatele jen s právy,
   která má asistent mít.

Název instance (tenant) je první část vaší adresy UOL: `https://firma.ucetnictvi.uol.cz` → `firma`.

Chcete si to nejdřív vyzkoušet? S `UOL_TENANT=demo` se použije veřejná DEMO firma od UOL, token není
potřeba.

## Nastavení

| Proměnná | Význam |
|---|---|
| `UOL_TENANT` | `demo`, název vaší instance (`firma`), prefix hostitele (`firma.sandbox`) nebo celá adresa `https://….uol.cz` |
| `UOL_EMAIL` | E-mail, kterým se přihlašujete do UOL |
| `UOL_TOKEN` | API token |
| `UOL_DOWNLOAD_DIR` | Kam se ukládají exportované a stažené soubory (výchozí `~/Downloads/uol-mcp`) |
| `UOL_TOOLSETS` | Seznam oddělený čárkami: `core`, `insights` (tyto dvě jsou výchozí), `ledger`, `banking`, `warehouse`, nebo `all` |
| `UOL_ACCESS` | `read` (výchozí), `write` nebo `full` — viz [Zápis](#zápis-volitelný) |
| `UOL_ACCOUNTS`, `UOL_DEFAULT_ACCOUNT` | Více firem v jednom serveru — viz [Více firem](#více-firem); `UOL_ACCOUNT_<NÁZEV>_ACCESS` nastaví úroveň přístupu jednoho účtu |
| `UOL_PROFILES_FILE` | Totéž ze souboru JSON |
| `UOL_UPLOAD_DIRS` | Složky, ze kterých smí `upload_document` číst (výchozí `~/Downloads`, `~/Desktop`, `~/Documents`; oddělené `:`, na Windows `;`). HTTP server žádné výchozí složky nemá: bez této proměnné přijímá jen `content_base64` |
| `UOL_AUDIT_LOG` | Soubor, do kterého se každý zápis zaznamená jako řádek JSON |
| `UOL_TIMEOUT_MS` | Časový limit jednoho požadavku na UOL (výchozí `30000`) |
| `UOL_DEBUG` | `1` vypisuje požadavky na stderr (nikdy přihlašovací údaje) |

### Claude Desktop

Nastavení → Developer → Edit Config a doplňte:

```json
{
  "mcpServers": {
    "uol": {
      "command": "npx",
      "args": ["-y", "uol-mcp"],
      "env": {
        "UOL_TENANT": "firma",
        "UOL_EMAIL": "vas@email.cz",
        "UOL_TOKEN": "vas-token"
      }
    }
  }
}
```

Po restartu Claude Desktop zkuste: *„Jaké jsou údaje naší firmy v UOL?“*

### Claude Code

```bash
claude mcp add uol -e UOL_TENANT=firma -e UOL_EMAIL=vas@email.cz -e UOL_TOKEN=vas-token -- npx -y uol-mcp
```

### Cursor / VS Code

Cursor (`.cursor/mcp.json`) používá stejný blok `mcpServers` jako Claude Desktop. VS Code
(`.vscode/mcp.json`):

```json
{
  "servers": {
    "uol": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "uol-mcp"],
      "env": { "UOL_TENANT": "firma", "UOL_EMAIL": "vas@email.cz", "UOL_TOKEN": "vas-token" }
    }
  }
}
```

### Docker

```bash
docker run -i --rm -e UOL_TENANT=firma -e UOL_EMAIL=vas@email.cz -e UOL_TOKEN=vas-token -v "$HOME/Downloads/uol-mcp:/data" ghcr.io/jakubbegera/uol-mcp
```

Exportované a stažené soubory se v kontejneru ukládají do `/data`; připojení přes `-v` je zachová.
V konfiguraci MCP klienta použijte jako příkaz `docker` a zbytek jako `args`.

### Rozšíření pro Claude Desktop

Každé vydání obsahuje soubor `uol-mcp.mcpb`. Otevřením ho nainstalujete a do formuláře vyplníte tenant,
e-mail a token; token se uloží jako tajný údaj. `bash scripts/build-mcpb.sh` sestaví balíček ze
zdrojového kódu.

### HTTP server (vlastní provoz)

```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN=$(openssl rand -hex 32) UOL_TENANT=firma UOL_EMAIL=vas@email.cz UOL_TOKEN=vas-token npx -y uol-mcp
```

Endpoint je `http://127.0.0.1:3000/mcp` (změníte přes `HOST` a `PORT`; `/health` pro kontroly
dostupnosti). Dva režimy:

- **Jedna firma**: přihlašovací údaje UOL jsou v prostředí serveru. Klienti musí posílat
  `Authorization: Bearer <MCP_AUTH_TOKEN>`; bez tokenu server nenastartuje.
- **Pass-through**: v prostředí žádné údaje UOL nejsou. Každý klient posílá v každém požadavku své
  hlavičky `X-UOL-Tenant`, `X-UOL-Email` a `X-UOL-Token`; server nic neukládá. Na localhostu je
  `MCP_AUTH_TOKEN` volitelný.

Přes HTTP se exportované faktury a stažené doklady vracejí přímo ve výsledku toolu místo uložení na
server a `upload_document` bere soubor jako `content_base64` — cesty na serveru nečte, pokud není
nastavené `UOL_UPLOAD_DIRS`. V Dockeru nechte server poslouchat na všech rozhraních a zveřejněte port:
`docker run -p 3000:3000 -e MCP_TRANSPORT=http -e HOST=0.0.0.0 -e MCP_AUTH_TOKEN=… -e MCP_ALLOWED_HOSTS=mcp.example.com …`.

| Proměnná | Význam |
|---|---|
| `MCP_TRANSPORT` | `http` spustí HTTP server (stejně jako `--http`) |
| `HOST`, `PORT` | Adresa a port, výchozí `127.0.0.1:3000` |
| `MCP_AUTH_TOKEN` | Bearer token, který klienti musí posílat, aspoň 32 znaků; povinný v režimu jedné firmy a vždy, když `HOST` není loopback adresa |
| `MCP_ALLOWED_HOSTS` | Povolené názvy v hlavičce `Host` (oddělené čárkou); povinné, když `HOST` není loopback adresa |
| `MCP_ALLOWED_ORIGINS` | Originy prohlížečů, které smí endpoint volat (výchozí žádné) |

Server mluví čistým HTTP: mimo localhost ho dejte za reverse proxy, která zajistí TLS. Na adrese mimo
loopback server bez `MCP_AUTH_TOKEN` a `MCP_ALLOWED_HOSTS` nenastartuje.

### Kontrola nastavení

```bash
UOL_TENANT=firma UOL_EMAIL=vas@email.cz UOL_TOKEN=vas-token npx -y uol-mcp doctor
```

## Zápis (volitelný)

S `UOL_ACCESS=write` (v rozšíření pro Claude Desktop pole „Access“ = `write`) přibudou tyto tools:

| Tool | Co dělá |
|---|---|
| `upload_document` | Nahraje PDF do schránky dokladů pro účetní (jen ze složek v `UOL_UPLOAD_DIRS`) |
| `create_sales_invoice` | Vystaví fakturu existujícímu kontaktu — jako koncept, pokud není `issue: true` |
| `update_sales_invoice` | Upraví nebo vystaví koncept faktury (vystavenou fakturu UOL měnit nedovolí) |
| `create_purchase_invoice` | Zaeviduje přijatou fakturu od existujícího dodavatele |
| `create_contact`, `update_contact` | Založí nebo upraví odběratele či dodavatele (duplicitní IČO odmítne) |
| `create_payment_demand` | Vytvoří upomínku k neuhrazeným fakturám jednoho odběratele — nikdy ji neodešle |
| `mark_document_processed`, `pair_uploaded_document`, `tag_uploaded_document`, `untag_uploaded_document` | Schránka účetní: stav dokladu, propojení se zaúčtovaným záznamem, štítky |

`UOL_ACCESS=full` přidá `delete_sales_invoice` (jen koncepty), `repair_sales_invoice` (storno nebo
vrácení vystavené faktury do konceptu) a `api_request` (obecný zápis do libovolného endpointu).

Položky faktur potřebují produkt z UOL (vypíše je `list_codebook` s `kind: products`). Každý zápis umí
`dry_run` (ukáže přesně, co by se odeslalo), opakované vytvoření stejného záznamu nevznikne dvakrát
(idempotency key) a tools jsou označené tak, aby se vás klient před spuštěním zeptal. S `UOL_AUDIT_LOG`
se každý zápis zaznamená.

## Více firem

Účetní s více klienty v UOL je obslouží jedním serverem. Účty vyjmenujte v `UOL_ACCOUNTS` a každému
dejte vlastní proměnné (název velkými písmeny, `-` se mění na `_`):

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

Výchozí je první účet (nebo ten v `UOL_DEFAULT_ACCOUNT`). S 1Password CLI spusťte server jako
`op run -- node …/dist/index.js` a odkazy `op://` se při startu nahradí tokeny — v konfiguraci tak
nezůstane nic tajného. `uol-mcp doctor` zkontroluje všechny účty.

Případně nasměrujte `UOL_PROFILES_FILE` na soubor JSON:

```json
{
  "default": "firma",
  "accounts": {
    "firma": { "tenant": "firma", "email": "ja@firma.cz", "token_env": "UOL_TOKEN_FIRMA" },
    "novak": { "tenant": "novak", "email": "ja@firma.cz", "token_env": "UOL_TOKEN_NOVAK", "label": "Novák s.r.o." }
  }
}
```

`token_env` je název proměnné prostředí s tokenem, takže soubor nemusí obsahovat nic tajného (token
přímo v `token` funguje taky; takový soubor mějte s právy `chmod 600`). Server pak nabízí
`list_accounts` a každý tool má argument `account` — *„Kdo dluží firmě Novák?“* půjde na správnou
instanci. Každý účet má vlastní limit požadavků.

Účty mohou mít vlastní úroveň přístupu: s `UOL_ACCESS=write` a `UOL_ACCOUNT_NOVAK_ACCESS=read` (nebo
`"access": "read"` v souboru s profily) jsou zápisy do firmy Novák odmítnuté, zatímco druhý účet
zapisovat smí. `list_accounts` ukáže úroveň každého účtu.

## Soukromí a bezpečnost

- Bez `UOL_ACCESS=write` server data jen čte. Text uvnitř faktur, poznámek a dokladů se bere jako data:
  před schválením zápisu si zkontrolujte, co asistent navrhuje.
- Vše, co tools vrátí, dostane AI model, který váš klient používá. Účetnictví obsahuje osobní údaje
  kontaktů a zaměstnanců — zvolte tarif, s jehož podmínkami souhlasíte.
- Přihlašovací údaje se posílají jen na `https://*.uol.cz` a nikdy se nezapisují do logů ani do
  výsledků toolů.
- Stažené soubory se ukládají jen do `UOL_DOWNLOAD_DIR`, čitelné jen pro vás, a nikdy nepřepíšou
  existující soubor (obsazený název dostane příponu ` (1)`). Soubory nad 50 MB se nestahují.
- Model dostává instrukci, že text z UOL (faktury, poznámky, doklady) jsou data, nikdy pokyny.

## Ze zdrojového kódu

Potřebuje Node.js 22 nebo novější.

```bash
git clone https://github.com/jakubbegera/uol-mcp.git
cd uol-mcp
npm install
npm run build
```

Pak v klientovi místo `npx -y uol-mcp` použijte `node /cesta/k/uol-mcp/dist/index.js`.

## Vývoj

```bash
npm test                 # unit a MCP testy proti nahraným odpovědím z DEMO
npm run typecheck
npm run smoke            # zavolá každý tool proti živému DEMO tenantu
npm run record-fixtures  # obnoví test/fixtures/demo z DEMO tenantu
bash scripts/build-mcpb.sh  # sestaví build/uol-mcp.mcpb
docker build -t uol-mcp .
```

CI spouští kontrolu typů, testy, `npm audit`, sken Docker image přes Trivy, CodeQL a u pull requestů
dependency review; Dependabot udržuje aktuální závislosti, actions i base image.

Vydání začíná pushnutím tagu `v*`; po schválení environmentu `release` správcem
`.github/workflows/release.yml` publikuje na npm, do GHCR, do GitHub Release (balíček MCPB) a do MCP
Registry.

Poznámky k návrhu, fakta o API a roadmapa jsou v [docs/DESIGN.md](docs/DESIGN.md).

## Zapojte se

Příspěvky jsou vítané — postup popisuje [CONTRIBUTING.md](CONTRIBUTING.md) (anglicky). Bezpečnostní
problémy prosím hlaste neveřejně podle [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE)
