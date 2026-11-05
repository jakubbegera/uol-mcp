/**
 * Names of the common synthetic (3-digit) accounts of the Czech chart of accounts for
 * businesses (směrná účtová osnova), classes 5 (náklady) and 6 (výnosy) — enough to
 * say what an account total is about without another lookup. The API has no
 * chart-of-accounts endpoint, so the names are fixed here; accounts not listed get none.
 */
const SYNTHETIC_ACCOUNTS: Readonly<Record<string, string>> = {
  '501': 'Spotřeba materiálu',
  '502': 'Spotřeba energie',
  '504': 'Prodané zboží',
  '511': 'Opravy a udržování',
  '512': 'Cestovné',
  '513': 'Náklady na reprezentaci',
  '518': 'Ostatní služby',
  '521': 'Mzdové náklady',
  '524': 'Zákonné sociální a zdravotní pojištění',
  '527': 'Zákonné sociální náklady',
  '531': 'Daň silniční',
  '538': 'Ostatní daně a poplatky',
  '543': 'Dary',
  '544': 'Smluvní pokuty a úroky z prodlení',
  '545': 'Ostatní pokuty a penále',
  '548': 'Ostatní provozní náklady',
  '549': 'Manka a škody z provozní činnosti',
  '551': 'Odpisy dlouhodobého nehmotného a hmotného majetku',
  '562': 'Úroky',
  '563': 'Kurzové ztráty',
  '568': 'Ostatní finanční náklady',
  '591': 'Daň z příjmů – splatná',
  '592': 'Daň z příjmů – odložená',
  '601': 'Tržby za vlastní výrobky',
  '602': 'Tržby z prodeje služeb',
  '604': 'Tržby za zboží',
  '641': 'Tržby z prodeje dlouhodobého nehmotného a hmotného majetku',
  '642': 'Tržby z prodeje materiálu',
  '644': 'Smluvní pokuty a úroky z prodlení',
  '648': 'Ostatní provozní výnosy',
  '662': 'Úroky',
  '663': 'Kurzové zisky',
  '668': 'Ostatní finanční výnosy',
};

/** The Czech name of synthetic account [account] (first three digits), or null. */
export function accountName(account: string): string | null {
  return SYNTHETIC_ACCOUNTS[account.slice(0, 3)] ?? null;
}
