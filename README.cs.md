# uol-mcp — návod

Napojení [UOL Účetnictví](https://www.uol.cz) na AI asistenty (Claude, Cursor a další klienty
s podporou [MCP](https://modelcontextprotocol.io)). Asistent pak umí odpovídat nad vaším účetnictvím:
vydané a přijaté faktury, kdo vám dluží, nahrané doklady, kontakty.

> **Neoficiální projekt.** Není spojený s UOL a.s. Komunikuje s veřejným
> [UOL REST API](https://api.uol.cz/) pomocí vašeho vlastního API tokenu.

[English](README.md)

Tohle je zkrácená příručka. Kompletní dokumentace — všechny tools, další klienty, Docker, HTTP server
a všechny proměnné prostředí — je v [anglickém README](README.md).

**Stav:** verze 0.5, ve výchozím stavu pouze čtení, zápis lze zapnout. Změny jednotlivých verzí
popisuje [CHANGELOG.md](CHANGELOG.md).

## Co umí

- **Přehled firmy jedním dotazem:** tento a minulý měsíc, DPH, pohledávky, doklady ke zpracování
  a zůstatky na účtech.
- **Tržby, náklady a zisk:** po měsících z hlavní knihy, stejně jako dashboard UOL, včetně
  největších nákladových a výnosových účtů.
- **DPH:** za zdaňovací období, k zaplacení nebo nadměrný odpočet, termín podání; u neuzavřeného
  období jako odhad z faktur.
- **Zůstatky na účtech:** podle účtů a měn (UOL eviduje měsíční počáteční stavy, ne aktuální zůstatek).
- **Faktury:** hledání vydaných i přijatých faktur, detail s položkami a DPH, stav úhrady
  u vydaných faktur.
- **Pohledávky:** kdo vám dluží, kolik a jak dlouho po splatnosti, součty podle měn.
- **Export:** PDF nebo ISDOC vydané faktury uložené na disk.
- **Kontakty:** odběratelé a dodavatelé podle názvu, IČO nebo DIČ, s adresami a bankovními účty.
- **Nahrané doklady:** co čeká na zpracování, stažení původního souboru.
- **Číselníky:** měny, střediska, zakázky, ceníky, vlastní bankovní účty a další.

Připravené postupy (v klientech jako příkazy s lomítkem): `monthly_review` (měsíční přehled),
`vat_check` (kontrola DPH), `overdue_followup` (návrhy upomínek, nic neodesílá) a `process_inbox`
(projde nahrané doklady). Seznam všech tools a volitelných sad je v
[anglickém README](README.md#what-it-can-do).

Příklady otázek:

- „Jak si letos stojíme?“
- „Kolik zaplatím DPH za tento kvartál?“
- „Na čem nejvíc utrácíme?“
- „Kdo mi dluží víc než 30 dní?“
- „Je faktura 2026000123 zaplacená?“
- „Kolik jsme letos fakturovali firmě Alza?“
- „Stáhni mi PDF poslední vydané faktury.“
- „Které nahrané doklady ještě účetní nezpracovala?“

## Jak získat API token

1. Otevřete v UOL stránku API tokenů (adresa `/api_tokens` na vaší instanci, např.
   `https://firma.ucetnictvi.uol.cz/api_tokens`) a vytvořte token.
2. Uživatel musí mít oprávnění **REST API**. Doporučujeme samostatného uživatele jen s právy,
   která má asistent mít.

Název instance (tenant) je první část vaší adresy UOL: `https://firma.ucetnictvi.uol.cz` → `firma`.

Chcete si to nejdřív vyzkoušet? S `UOL_TENANT=demo` se použije veřejná DEMO firma od UOL,
token není potřeba.

## Nastavení v Claude Desktop

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

Po restartu Claude Desktop zkuste: „Jaké jsou údaje naší firmy v UOL?“

Ostatní klienty (Claude Code, Cursor, VS Code), Docker, HTTP server a všechny proměnné prostředí
popisuje [anglické README](README.md#configuration).

## Zápis (volitelný)

S `UOL_ACCESS=write` (v Claude Desktop rozšíření pole „Access“ = `write`) asistent umí navíc:

- **nahrát doklad** (PDF) účetní do UOL, a to jen ze složek Stažené soubory, Plocha a Dokumenty
  (nebo ze složek v `UOL_UPLOAD_DIRS`);
- **vystavit fakturu** existujícímu kontaktu, standardně jako koncept;
- **upravit nebo vystavit koncept faktury**; už vystavenou fakturu UOL měnit nedovolí;
- **zaevidovat přijatou fakturu**, **založit nebo upravit kontakt** (s kontrolou duplicitního IČO);
- **vytvořit upomínku** k neuhrazeným fakturám jednoho odběratele (nic se neodesílá);
- **zpracovat nahrané doklady**: označit jako zpracované, spárovat s fakturou, přidat štítek.

S `UOL_ACCESS=full` navíc smazání konceptu faktury, storno nebo vrácení vystavené faktury do konceptu
a obecný zápis do libovolného endpointu.

Před každým zápisem si asistent nechá vše ukázat nanečisto a klient vás požádá o souhlas.
Opakované vytvoření stejné faktury nevznikne dvakrát. Všechny zápisové tools popisuje
[anglické README](README.md#writing-opt-in).

## Více firem (pro účetní)

Jeden server obslouží víc klientských firem. Účty vyjmenujete v `UOL_ACCOUNTS` a každému dáte
vlastní proměnné, vše přímo v konfiguraci klienta:

```json
"env": {
  "UOL_ACCOUNTS": "firma,novak",
  "UOL_ACCOUNT_FIRMA_TENANT": "firma",
  "UOL_ACCOUNT_FIRMA_EMAIL": "vas@email.cz",
  "UOL_ACCOUNT_FIRMA_TOKEN": "token-firmy",
  "UOL_ACCOUNT_NOVAK_TENANT": "novak",
  "UOL_ACCOUNT_NOVAK_EMAIL": "vas@email.cz",
  "UOL_ACCOUNT_NOVAK_TOKEN": "token-novaka",
  "UOL_ACCOUNT_NOVAK_LABEL": "Novák s.r.o."
}
```

Výchozí je první účet. Asistent pak u každého dotazu ví, které firmy se týká, třeba „Kdo dluží firmě
Novák?“. Každý účet může mít vlastní úroveň přístupu: s `"UOL_ACCOUNT_NOVAK_ACCESS": "read"` asistent
do firmy Novák nic nezapíše, i když jinde zapisovat smí.

Tokeny nemusí být v konfiguraci napsané přímo: s 1Password CLI stačí odkazy `op://…` a server spustit
přes `op run`. Stejné nastavení jde mít i v souboru (`UOL_PROFILES_FILE`), viz
[anglické README](README.md#several-companies).

## Soukromí a bezpečnost

- Bez `UOL_ACCESS=write` server data jen čte. Text uvnitř faktur, poznámek a dokladů je pro
  asistenta jen data: před schválením zápisu si zkontrolujte, co navrhuje.
- Vše, co nástroje vrátí, dostane AI model, který váš klient používá. Účetnictví obsahuje osobní
  údaje kontaktů a zaměstnanců; zvolte si takový tarif, s jehož podmínkami souhlasíte.
- Přihlašovací údaje se posílají jen na `https://*.uol.cz` a nikdy se nezapisují do logů.
- Stažené soubory se ukládají jen do složky `UOL_DOWNLOAD_DIR` (výchozí `~/Downloads/uol-mcp`),
  čitelné jen pro vás, a nikdy nepřepíšou existující soubor. Soubory nad 50 MB se nestahují.
- Model dostává instrukci, že text z UOL (faktury, poznámky, doklady) jsou data, nikdy pokyny.

Podrobnosti včetně HTTP serveru jsou v [anglickém README](README.md#privacy-and-safety).

## Zapojte se

Příspěvky jsou vítané: chyby, zvláštnosti API, nové nástroje i úpravy dokumentace. Postup popisuje
[CONTRIBUTING.md](CONTRIBUTING.md) (anglicky). Bezpečnostní problémy prosím hlaste neveřejně podle
[SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE)
