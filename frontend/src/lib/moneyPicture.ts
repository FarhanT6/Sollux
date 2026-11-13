import type { WalletsT, WalletKind } from '../api/client';

/**
 * Where the owner's money is, the same everywhere it is totalled (Overview, Settings → Banking,
 * Cash, checks & apps): the bank accounts, plus cash, checks on hand and payment-app balances from
 * Cash, checks & apps (kept current as rent is logged and money moves).
 *
 * A balance typed in by hand on an account named for cash or an app (an older way to track it) is
 * left out once Cash, checks & apps has a wallet of that kind in use, so nothing counts twice; it
 * still counts where no such wallet is used. The pay planner follows the same rule (backend
 * lib/payPlan.ts).
 */

type Acct = {
  id: string; name?: string | null; bank?: string | null; accountType?: string; isActive?: boolean; plaidAccountId?: string | null;
  balance?: number | null; available?: number | null; balances?: { balance?: unknown; available?: unknown }[];
};

const APP_WORDS: [RegExp, WalletKind][] = [[/apple\s*cash|apple\s*pay/i, 'APPLE_CASH'], [/cash\s*app/i, 'CASH_APP'], [/venmo/i, 'VENMO'], [/paypal/i, 'PAYPAL']];
export const WALLET_PAGE = '/finances?tab=income&view=wallets';
export const BANKING_PAGE = '/settings?tab=banking';

/** The wallet a hand-entered account stands for: an app by its name, cash by its type or name. Bank accounts are none. */
export function walletKindOf(a: Acct): WalletKind | null {
  if (a.plaidAccountId || a.accountType === 'CREDIT_CARD') return null;
  const text = `${a.name ?? ''} ${a.bank ?? ''}`;
  for (const [re, kind] of APP_WORDS) if (re.test(text)) return kind;
  if (a.accountType === 'CASH_POOL' || /^\s*(petty\s+)?cash\b|cash\s+on\s+hand/i.test(a.name ?? '')) return 'CASH';
  return null;
}

/** The latest balance, from either shape the API sends (a `balances` list, or flat fields). */
export function balanceOf(a: Acct, prefer: 'available' | 'ledger' = 'available'): number {
  const b = a.balances?.[0] ?? a;
  const v = prefer === 'available' ? (b.available ?? b.balance) : b.balance;
  return Number(v ?? 0) || 0;
}

export interface WalletLine { id: string; kind: WalletKind; label: string; balance: number; detail: string | null }
export interface MoneyPicture<A extends Acct = Acct> {
  /** Checking, savings and other bank accounts (connected, or entered by hand). */
  banks: { total: number; accounts: A[] };
  /** Cash, checks on hand and app balances from Cash, checks & apps; null when they could not be loaded. */
  wallets: { total: number; cash: number; checks: number; checksCount: number; apps: number; lines: WalletLine[] } | null;
  /** Cash or app balances typed in by hand where no wallet of the kind is in use: still counted. */
  handTyped: { total: number; accounts: A[] };
  /** Typed-in cash or app balances Cash, checks & apps now keeps: shown, not counted. */
  replaced: A[];
  credit: { total: number; accounts: A[] };
  total: number;
}

export function moneyPicture<A extends Acct>(accounts: A[], wallets: WalletsT | null): MoneyPicture<A> {
  const inUse = new Set<WalletKind>();
  const lines: WalletLine[] = [];
  let cash = 0, checks = 0, checksCount = 0, apps = 0;
  for (const w of wallets?.wallets ?? []) {
    const onHand = w.onHand ?? [];
    if (Math.abs(w.balance) > 0.005 || w.entries.length || onHand.length) inUse.add(w.kind);
    if (w.kind === 'CASH') cash += w.balance;
    else if (w.kind === 'CHECK') { checks += w.balance; checksCount += onHand.length; }
    else apps += w.balance;
    if (Math.abs(w.balance) > 0.005 || (w.kind === 'CHECK' && onHand.length)) {
      lines.push({ id: w.id, kind: w.kind, label: w.kind === 'CHECK' ? 'Checks on hand' : w.label, balance: w.balance, detail: w.kind === 'CHECK' ? `${onHand.length} not deposited` : null });
    }
  }
  const banks: A[] = [], handTyped: A[] = [], replaced: A[] = [], credit: A[] = [];
  for (const a of accounts) {
    if (a.isActive === false) continue;
    if (a.accountType === 'CREDIT_CARD') { credit.push(a); continue; }
    const kind = walletKindOf(a);
    if (!kind) banks.push(a);
    else if (wallets && inUse.has(kind)) replaced.push(a);
    else handTyped.push(a);
  }
  const sum = (xs: A[], prefer: 'available' | 'ledger' = 'available') => xs.reduce((t, a) => t + balanceOf(a, prefer), 0);
  const walletTotal = cash + checks + apps;
  const banksTotal = sum(banks), handTotal = sum(handTyped, 'ledger');
  return {
    banks: { total: banksTotal, accounts: banks },
    wallets: wallets ? { total: walletTotal, cash, checks, checksCount, apps, lines } : null,
    handTyped: { total: handTotal, accounts: handTyped },
    replaced,
    credit: { total: sum(credit, 'ledger'), accounts: credit },
    total: banksTotal + (wallets ? walletTotal : 0) + handTotal,
  };
}

/** The tiles under a total: Banks, Cash, Checks on hand, Payment apps, Entered by hand — each with where it is managed. */
export function moneyTiles(p: MoneyPicture): { label: string; total: number; sub: string; to: string }[] {
  const tiles = [{ label: 'Banks', total: p.banks.total, sub: `${p.banks.accounts.length} account${p.banks.accounts.length === 1 ? '' : 's'}`, to: BANKING_PAGE, show: p.banks.accounts.length > 0 }];
  if (p.wallets) {
    const appNames = p.wallets.lines.filter(l => l.kind !== 'CASH' && l.kind !== 'CHECK').map(l => l.label);
    tiles.push(
      { label: 'Cash', total: p.wallets.cash, sub: 'on hand', to: WALLET_PAGE, show: Math.abs(p.wallets.cash) > 0.005 },
      { label: 'Checks on hand', total: p.wallets.checks, sub: `${p.wallets.checksCount} not deposited`, to: WALLET_PAGE, show: p.wallets.checksCount > 0 || Math.abs(p.wallets.checks) > 0.005 },
      { label: 'Payment apps', total: p.wallets.apps, sub: appNames.join(', ') || 'Venmo, Cash App, PayPal, Apple Cash', to: WALLET_PAGE, show: Math.abs(p.wallets.apps) > 0.005 },
    );
  }
  tiles.push({ label: 'Entered by hand', total: p.handTyped.total, sub: `${p.handTyped.accounts.length} cash or app balance${p.handTyped.accounts.length === 1 ? '' : 's'}`, to: BANKING_PAGE, show: p.handTyped.accounts.length > 0 });
  return tiles.filter(t => t.show).map(({ show: _s, ...t }) => t);
}
