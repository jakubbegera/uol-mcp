# uol-mcp — návod

Napojení [UOL Účetnictví](https://www.uol.cz) na AI asistenty (Claude, Cursor a další klienty
s podporou [MCP](https://modelcontextprotocol.io)). Asistent pak umí odpovídat nad vaším účetnictvím:
vydané a přijaté faktury, kdo vám dluží, nahrané doklady, kontakty.

> **Neoficiální projekt.** Není spojený s UOL a.s. Komunikuje s veřejným
> [UOL REST API](https://api.uol.cz/) pomocí vašeho vlastního API tokenu.

[English](README.md)

**Stav:** verze 0.4, ve výchozím stavu pouze čtení, zápis lze zapnout.

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

Ostatní klienty (Claude Code, Cursor, VS Code), Docker, HTTP server a všechny proměnné prostředí
popisuje [anglické README](README.md#configuration).

## Zápis (volitelný)

S `UOL_ACCESS=write` (v Claude Desktop rozšíření pole „Access“ = `write`) asistent umí navíc:

- **nahrát doklad** (PDF) účetní do UOL, a to jen ze složek Stažené soubory, Plocha a Dokumenty;
- **vystavit fakturu** existujícímu kontaktu, standardně jako koncept;
- **upravit nebo vystavit koncept faktury**; už vystavenou fakturu UOL měnit nedovolí;
- **zaevidovat přijatou fakturu**, **založit nebo upravit kontakt** (s kontrolou duplicitního IČO);
- **vytvořit upomínku** k neuhrazeným fakturám jednoho odběratele (nic se neodesílá);
- **zpracovat nahrané doklady**: označit jako zpracované, spárovat s fakturou, přidat štítek.

S `UOL_ACCESS=full` navíc smazání konceptu faktury, storno nebo vrácení vystavené faktury do konceptu
a obecný zápis do libovolného endpointu.

Před každým zápisem si asistent nechá vše ukázat nanečisto a klient vás požádá o souhlas.
Opakované vytvoření stejné faktury nevznikne dvakrát.

## Více firem (pro účetní)

Jeden server obslouží víc klientských firem: v souboru `UOL_PROFILES_FILE` je seznam účtů (tenant,
e-mail, token nebo název proměnné s tokenem). Asistent pak u každého dotazu ví, které firmy se týká,
třeba „Kdo dluží firmě Novák?“. Formát souboru popisuje [anglické README](README.md#several-companies).

## Soukromí a bezpečnost

- Bez `UOL_ACCESS=write` server data jen čte. Text uvnitř faktur, poznámek a dokladů je pro
  asistenta jen data: před schválením zápisu si zkontrolujte, co navrhuje.
- Vše, co nástroje vrátí, dostane AI model, který váš klient používá. Účetnictví obsahuje osobní
  údaje kontaktů a zaměstnanců; zvolte si takový tarif, s jehož podmínkami souhlasíte.
- Přihlašovací údaje se posílají jen na `https://*.uol.cz` a nikdy se nezapisují do logů.
- Stažené soubory se ukládají jen do složky `UOL_DOWNLOAD_DIR` (výchozí `~/Downloads/uol-mcp`).

## Licence

[MIT](LICENSE)
