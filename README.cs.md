# uol-mcp — návod

Napojení [UOL Účetnictví](https://www.uol.cz) na AI asistenty (Claude, Cursor a další klienty
s podporou [MCP](https://modelcontextprotocol.io)). Asistent pak umí odpovídat nad vaším účetnictvím:
vydané a přijaté faktury, kdo vám dluží, nahrané doklady, kontakty.

> **Neoficiální projekt.** Není spojený s UOL a.s. Komunikuje s veřejným
> [UOL REST API](https://api.uol.cz/) pomocí vašeho vlastního API tokenu.

[English](README.md)

**Stav:** verze 0.2, pouze čtení. Zatím není na npm; do prvního vydání se spouští
[ze zdrojového kódu](README.md#from-source).

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
(projde nahrané doklady).

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

Ostatní klienty (Claude Code, Cursor, VS Code) a všechny proměnné prostředí popisuje
[anglické README](README.md#configuration).

## Soukromí a bezpečnost

- Server data jen čte. Zápis (nahrávání dokladů, vystavování faktur) bude volitelný
  a ve výchozím stavu vypnutý.
- Vše, co nástroje vrátí, dostane AI model, který váš klient používá. Účetnictví obsahuje osobní
  údaje kontaktů a zaměstnanců; zvolte si takový tarif, s jehož podmínkami souhlasíte.
- Přihlašovací údaje se posílají jen na `https://*.uol.cz` a nikdy se nezapisují do logů.
- Stažené soubory se ukládají jen do složky `UOL_DOWNLOAD_DIR` (výchozí `~/Downloads/uol-mcp`).

## Licence

[MIT](LICENSE)
