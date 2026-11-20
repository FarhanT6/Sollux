/**
 * A bank line that moves money in or out of a wallet on Cash, checks & apps
 * (services/walletBankLines.ts records it):
 *  - APP_TO_BANK: Venmo / Cash App / PayPal / Apple Cash paying out to the bank ("VENMO CASHOUT");
 *  - BANK_TO_APP: the bank funding an app's balance ("Cash App*Add Cash", a PayPal transfer out);
 *  - CASH_WITHDRAWAL: cash taken out (an ATM or teller withdrawal) — into the Cash wallet;
 *  - CASH_DEPOSIT: cash put in ("CASH DEPOSIT") — out of the Cash wallet.
 * Only lines that say so: a bare "DEPOSIT" can be checks (those clear by their deposit slip), a
 * "VENMO PAYMENT" debit is a payment to someone (the balance does not change), and a bare app
 * credit is left to the rent matching. Plaid's sign: positive = money out of the account.
 */
export type AppWallet = 'VENMO' | 'CASH_APP' | 'PAYPAL' | 'APPLE_CASH';
export type WalletLine =
  | { kind: 'APP_TO_BANK' | 'BANK_TO_APP'; wallet: AppWallet }
  | { kind: 'CASH_WITHDRAWAL' | 'CASH_DEPOSIT'; wallet: 'CASH' };

const APPS: [RegExp, AppWallet][] = [
  [/\bvenmo\b/i, 'VENMO'],
  [/cash ?app|square cash|sq \*cash/i, 'CASH_APP'],
  [/paypal/i, 'PAYPAL'],
  [/apple ?(pay )?cash/i, 'APPLE_CASH'],
];
const OUT_OF_APP = /cash ?out|transfer|xfer|withdraw|payout/i;
const INTO_APP = /\badd(?:ed)?\s+(?:cash|money|funds)\b|\btop\s?-?up\b/i;
const FEE = /\bfee\b|surcharge/i;
const ATM_CASH_OUT = /\batm\b.{0,30}\b(?:withdraw\w*|w\/d|wd|cash)\b|\b(?:withdraw\w*|w\/d)\b.{0,30}\batm\b|cash withdrawal/i;
const CASH_IN = /cash\s+dep(?:osit)?\b|\bdep(?:osit)?\b\s*[-:]?\s*cash\b|\batm\b.{0,20}\bcash\b.{0,10}\bdep/i;

export function walletLineOf(t: { name: string; amount: number; category?: string | null }): WalletLine | null {
  const name = t.name ?? '';
  const app = APPS.find(([re]) => re.test(name))?.[1] ?? null;
  const credit = t.amount < 0;
  if (app) {
    if (credit && OUT_OF_APP.test(name)) return { kind: 'APP_TO_BANK', wallet: app };
    if (!credit && (INTO_APP.test(name) || (app === 'PAYPAL' && /\btransfer\b/i.test(name) && !/inst\w*\s*xfer/i.test(name)))) return { kind: 'BANK_TO_APP', wallet: app };
    return null;
  }
  if (!credit && !FEE.test(name) && (ATM_CASH_OUT.test(name) || t.category === 'TRANSFER_OUT_WITHDRAWAL')) return { kind: 'CASH_WITHDRAWAL', wallet: 'CASH' };
  if (credit && CASH_IN.test(name)) return { kind: 'CASH_DEPOSIT', wallet: 'CASH' };
  return null;
}
