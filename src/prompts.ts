import type { GetPromptResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Toolset } from './config.js';

/*
 * Ready-made workflows, shown by clients as slash commands. The text is
 * Czech because it is sent as the user's own message and the answers should
 * come back in Czech; every prompt stays read-only.
 */

const ask = (text: string): GetPromptResult => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

const STYLE =
  'Odpovídej česky, stručně a v bodech. Částky uváděj s měnou a nikdy nesčítej různé měny. ' +
  'Pokud nějaký údaj chybí nebo je jen odhad, řekni to.';

export function registerPrompts(server: McpServer, toolsets: ReadonlySet<Toolset>): void {
  if (toolsets.has('insights')) {
    server.registerPrompt(
      'monthly_review',
      {
        title: 'Měsíční přehled',
        description: 'Tržby, náklady, zisk, DPH, pohledávky a nezpracované doklady za měsíc',
        argsSchema: z.object({
          month: z.string().optional().describe('Měsíc jako YYYY-MM; bez zadání aktuální měsíc'),
        }),
      },
      ({ month }) =>
        ask(
          `Připrav měsíční přehled firmy v UOL za ${month ? `měsíc ${month}` : 'aktuální měsíc'}.\n\n` +
            '1. get_financial_overview: tržby, náklady a zisk, srovnání s předchozím měsícem a největší nákladové účty. ' +
            'Zvol parametr months tak, aby přehled zahrnul i předchozí měsíc.\n' +
            '2. get_vat_overview: DPH za odpovídající období, termín podání a zda jde o předběžný odhad.\n' +
            '3. list_receivables s overdue_only: kdo dluží po splatnosti a kolik.\n' +
            '4. list_uploaded_documents se stavem unprocessed: co ještě čeká na účetní.\n\n' +
            `Na konci upozorni na neobvyklé změny a na to, co je potřeba udělat. ${STYLE}`,
        ),
    );

    server.registerPrompt(
      'vat_check',
      {
        title: 'Kontrola DPH',
        description: 'DPH za období, termín podání a doklady, které ho mohou ještě změnit',
        argsSchema: z.object({
          period: z.string().optional().describe('Období jako YYYY-MM nebo YYYY-Qn; bez zadání aktuální'),
        }),
      },
      ({ period }) =>
        ask(
          `Zkontroluj DPH za ${period ? `období ${period}` : 'aktuální zdaňovací období'}.\n\n` +
            '1. get_vat_overview: DPH na výstupu, na vstupu, výsledná povinnost nebo nadměrný odpočet a termín podání. ' +
            'Je-li období preliminary, vysvětli, že jde o odhad z faktur, a co v něm chybí.\n' +
            '2. list_uploaded_documents se stavem unprocessed: nezpracované doklady, které mohou DPH ještě změnit.\n' +
            '3. Pokud termín podání brzy vyprší, výslovně na to upozorni.\n\n' +
            STYLE,
        ),
    );
  }

  if (toolsets.has('core')) {
    server.registerPrompt(
      'overdue_followup',
      {
        title: 'Upomínky po splatnosti',
        description: 'Návrhy zdvořilých upomínek k fakturám po splatnosti (nic neodesílá)',
        argsSchema: z.object({
          min_days_overdue: z.string().optional().describe('Minimální počet dní po splatnosti, výchozí 14'),
        }),
      },
      ({ min_days_overdue }) =>
        ask(
          `Najdi vydané faktury, které jsou víc než ${min_days_overdue || '14'} dní po splatnosti ` +
            '(list_receivables s overdue_only a sort=outstanding), a seskup je podle odběratele.\n\n' +
            'Ke každému odběrateli připrav krátký, zdvořilý a věcný text upomínky v češtině: čísla faktur, částky, ' +
            'datum splatnosti a variabilní symbol (z get_sales_invoice). Kontakt odběratele dohledej přes get_contact.\n\n' +
            `Nic neodesílej, připrav jen návrhy textů. ${STYLE}`,
        ),
    );

    server.registerPrompt(
      'process_inbox',
      {
        title: 'Projít nahrané doklady',
        description: 'Shrne nezpracované nahrané doklady a navrhne, ke kterým fakturám patří (nic nemění)',
      },
      () =>
        ask(
          'Projdi nahrané doklady ve stavu unprocessed (list_uploaded_documents).\n\n' +
            'U každého zjisti detail (get_uploaded_document); když je potřeba, stáhni soubor (download_uploaded_document) a přečti ho. ' +
            'Shrň, co doklad je (dodavatel, částka, datum, IČO), a navrhni, ke které přijaté faktuře by mohl patřit ' +
            '(search_purchase_invoices), případně že odpovídající faktura chybí.\n\n' +
            `Nic neměň. ${STYLE}`,
        ),
    );
  }
}
