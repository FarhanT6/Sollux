import { useState, type ReactNode } from 'react';
import { Screen, Section, Row, Segmented, Sheet, Field, BarButton, Icon, categoryIcon } from '../../ios';
import { fmtMoney } from '../../lib/money';
import { fmtDate, billMonthLabel } from '../../lib/date';
import { bankAccountLabel } from '../../lib/bankAccountLabel';
import { CADENCE_LABELS } from '../../lib/cadence';
import { CATEGORY_LABELS } from '../../types';
import UrgentNotices from '../../components/UrgentNotices';
import PortalCodeBanner from '../../components/utility/PortalCodeBanner';
import PaymentBreakdownLine from '../../components/utility/PaymentBreakdownLine';

/**
 * Everything the account screen shows and does, handed over by
 * UtilityDetailPage. The page owns the data and every rule (paid state,
 * balances, payments); this is only how a phone presents it, so the two can
 * never disagree about a bill.
 */
export interface UtilityAccountView {
  account: any;
  propertyLabel: string;
  statements: any[];
  payments: any[];
  latestId: string | null;
  balance: number | null;
  isLatestPaid: boolean;
  balanceSub: ReactNode;
  momPct: number | null;
  ytdOperating: number;
  totalPaid: number;
  totalFees: number;
  feesData: { id: string; date: string; total: number; lines: { label: string; amount: number }[]; unexplained: number }[];
  statusOf: (s: any, idx: number) => { color: 'green' | 'amber' | 'red'; label: string };
  isPaid: (s: any) => boolean;
  totalDueOf: (s: any) => number | null;
  markingPaid: string | null;
  markPaid: (s: any) => void;
  markUnpaid: (s: any) => void;
  openPdf: (s: any) => void;
  editStatement: (s: any) => void;
  reload: () => Promise<unknown>;
  sync: () => void;
  syncing: boolean;
  setCadence: (v: string) => void;
  toggleActive: () => void;
  remove: () => void;
  revealNumber: () => void;
  revealedNumber: string | null;
  /** The provider's site ("sdge.com"), or null when it is not known yet. */
  siteLabel: string | null;
  openWebsite: () => void;
  saveWebsite: () => void;
  openPortalLogin: () => void;
  /** The website is a bill lookup page: the name on the bill instead of a login. */
  lookupPage: boolean;
  saveLookupName: (name: string) => Promise<void>;
  payment: {
    open: boolean; editing: boolean; saving: boolean; canSave: boolean; fields: ReactNode;
    start: () => void; edit: (p: any) => void; close: () => void; save: () => void; remove: (p: any) => void;
  };
  arrangements: ReactNode;
  addPlan: () => void;
  addLoan: () => void;
  hasPlan: boolean;
  hasLoan: boolean;
  charges: ReactNode;
  modals: ReactNode;
}

type Tab = 'bills' | 'payments' | 'fees' | 'charges';
const TONE = { green: 'ios-green', amber: 'ios-tint', red: 'ios-red' } as const;

export default function UtilityAccountScreen(v: UtilityAccountView) {
  const { account } = v;
  // The name on the bill, for a bill lookup page: edited in its own sheet.
  const [nameSheet, setNameSheet] = useState(false);
  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const editName = () => { setName(account.lookupName ?? ''); setNameSheet(true); };
  const [tab, setTab] = useState<Tab>('bills');
  const [bill, setBill] = useState<any | null>(null);
  const [pay, setPay] = useState<any | null>(null);
  const [actions, setActions] = useState(false);

  const billIdx = bill ? v.statements.findIndex(s => s.id === bill.id) : -1;
  const billStatus = bill ? v.statusOf(bill, billIdx) : null;

  return (
    <Screen title={account.providerName} back
      subtitle={`${CATEGORY_LABELS[account.category as keyof typeof CATEGORY_LABELS] ?? account.category} · ${v.propertyLabel}`}
      onRefresh={v.reload}
      right={<BarButton label="Account actions" onClick={() => setActions(true)}><Icon.Ellipsis /></BarButton>}>

      {account.mfaPrompt && (
        <div style={{ marginBottom: 12 }}>
          <PortalCodeBanner accountId={account.id} prompt={account.mfaPrompt} requestedAt={account.mfaRequestedAt} providerName={account.providerName} />
        </div>
      )}
      <UrgentNotices utilityAccountId={account.id} className="mb-3" />

      <div className="ios-card" style={{ marginBottom: 12 }}>
        <div className="ios-hero-label">Current balance</div>
        <div className="ios-hero-value">{fmtMoney(v.balance)}</div>
        <div className="ios-hero-sub">{v.balanceSub}</div>
        <button className="ios-btn gray" style={{ marginTop: 14, width: '100%' }} onClick={v.openWebsite}>
          {v.siteLabel ? `Pay on ${v.siteLabel}` : 'Find the provider\'s website'}
        </button>
        {account.lastSyncStatus === 'FAILED' && account.lastSyncError && !v.syncing && (
          <div className="ios-hero-sub ios-red" style={{ marginTop: 6 }}>Last sync failed: {account.lastSyncError}</div>
        )}
      </div>
      <div className="ios-chips" style={{ marginBottom: 20 }}>
        <div className="ios-chip"><div className="k">vs last bill</div>
          <div className={`v ${v.momPct == null ? '' : v.momPct > 0 ? 'ios-red' : 'ios-green'}`}>{v.momPct == null ? '—' : `${v.momPct > 0 ? '↑' : '↓'} ${Math.abs(v.momPct).toFixed(1)}%`}</div></div>
        <div className="ios-chip"><div className="k">This year</div><div className="v">{fmtMoney(v.ytdOperating || null)}</div></div>
        <div className="ios-chip"><div className="k">Paid in all</div><div className="v">{fmtMoney(v.totalPaid || null)}</div></div>
        <div className="ios-chip"><div className="k">Fees</div><div className={`v ${v.totalFees > 0 ? 'ios-red' : ''}`}>{fmtMoney(v.totalFees || null)}</div></div>
      </div>

      {v.arrangements}

      {v.lookupPage && !account.lookupName && (
        <Section footer="This provider's website finds the bills by account number and the name the bill is addressed to — no login needed.">
          <Row title="Add the name on the bill" subtitle="So Sollux can look up the bills" tinted onClick={editName} />
        </Section>
      )}
      {!account.hasCredentials && !v.lookupPage && (
        <Section footer="Sollux signs in to read and download statements only — it can't pay or change anything.">
          <Row title="Fetch statements automatically" subtitle={`Add your ${account.providerName} login`} tinted onClick={v.openPortalLogin} />
        </Section>
      )}

      <Segmented<Tab> label="Show" value={tab} onChange={setTab} options={[
        { value: 'bills', label: 'Bills' }, { value: 'payments', label: 'Payments' },
        { value: 'fees', label: 'Fees' }, { value: 'charges', label: 'Charges' },
      ]} />

      {tab === 'bills' && (
        <Section header={`${v.statements.length} statement${v.statements.length === 1 ? '' : 's'}`}
          action={{ label: 'Add', onClick: () => v.editStatement({}) }}>
          {v.statements.length === 0 && <Row title="No statements yet" subtitle="Sync, scan or import a bill" chevron={false} />}
          {v.statements.map((s, idx) => {
            const st = v.statusOf(s, idx);
            const total = v.totalDueOf(s) ?? Number(s.amountDue ?? 0);
            return (
              <Row key={s.id} onClick={() => setBill(s)}
                title={<>{billMonthLabel(s)}{s.id === v.latestId && <span className="ios-tint" style={{ fontSize: 13, marginLeft: 6 }}>Latest</span>}</>}
                subtitle={<><span className={TONE[st.color]}>{st.label}</span>{s.dueDate ? ` · due ${fmtDate(s.dueDate, 'MMM d')}` : ''}</>}
                value={<span className={total < 0 ? 'ios-green' : 'strong'}>{total < 0 ? `−${fmtMoney(-total)}` : fmtMoney(total)}</span>}
                swipe={v.isPaid(s)
                  ? [{ label: 'Unpaid', color: 'var(--ios-orange)', onClick: () => v.markUnpaid(s) }]
                  : [{ label: 'Paid', color: 'var(--ios-green)', onClick: () => v.markPaid(s) }]}
              />
            );
          })}
        </Section>
      )}

      {tab === 'payments' && (
        <Section header={`${v.payments.length} payment${v.payments.length === 1 ? '' : 's'}`}
          action={{ label: 'Log payment', onClick: v.payment.start }}>
          {v.payments.length === 0 && <Row title="Nothing recorded yet" chevron={false} />}
          {v.payments.map(p => (
            <Row key={p.id} onClick={() => setPay(p)}
              title={fmtDate(p.paymentDate, 'MMM d, yyyy')}
              subtitle={[p.paymentMethod, p.statement ? `toward ${billMonthLabel(p.statement)}` : null].filter(Boolean).join(' · ') || 'Payment'}
              value={<><span className="strong">{fmtMoney(p.amount)}</span>{p.status !== 'PAID' && <span className={`small ${p.status === 'PENDING' ? 'ios-tint' : 'ios-red'}`}>{p.status}</span>}</>}
            />
          ))}
        </Section>
      )}

      {tab === 'fees' && (
        <Section header="Penalties and fees" footer={v.feesData.length ? `${fmtMoney(v.totalFees)} across ${v.feesData.length} bills.` : undefined}>
          {v.feesData.length === 0 && <Row title="No fees or penalties" chevron={false} />}
          {v.feesData.map(r => (
            <Row key={r.id} chevron={false} wrap title={fmtDate(r.date, 'MMMM yyyy')}
              subtitle={[...r.lines.map(l => `${l.label} ${fmtMoney(l.amount)}`), Math.abs(r.unexplained) > 0.005 ? `Other ${fmtMoney(r.unexplained)}` : null].filter(Boolean).join(' · ')}
              value={<span className="ios-red strong">{fmtMoney(r.total)}</span>} />
          ))}
        </Section>
      )}

      {tab === 'charges' && <div className="ios-embedded">{v.charges}</div>}

      {/* One bill: what the statement printed, and what to do with it. */}
      <Sheet open={!!bill} onClose={() => setBill(null)} title={bill ? billMonthLabel(bill) : ''} left={null}
        right={{ label: 'Done', onClick: () => setBill(null) }}>
        {bill && <BillDetail s={bill} v={v} status={billStatus!} close={() => setBill(null)} />}
      </Sheet>

      {/* One payment. */}
      <Sheet open={!!pay} onClose={() => setPay(null)} title="Payment" left={null}
        right={{ label: 'Done', onClick: () => setPay(null) }}>
        {pay && (
          <>
            <div style={{ textAlign: 'center', margin: '8px 0 20px' }}>
              <div className="ios-hero-value">{fmtMoney(pay.amount)}</div>
              <div className="ios-hero-sub">{fmtDate(pay.paymentDate, 'EEEE, MMM d, yyyy')}</div>
            </div>
            <Section>
              <Row title="Status" value={pay.status} chevron={false} />
              {pay.paymentMethod && <Row title="Method" value={pay.paymentMethod} chevron={false} />}
              {pay.bankAccount && <Row title="From" value={bankAccountLabel(pay.bankAccount)} chevron={false} />}
              {pay.statement && <Row title="Toward" value={`${billMonthLabel(pay.statement)} bill`} chevron={false} />}
              {Number(pay.feeAmount ?? 0) > 0 && <Row title="Transaction fee" value={fmtMoney(pay.feeAmount)} chevron={false} />}
              {Number(pay.lateFeeAdded ?? 0) > 0 && <Row title="Late fee included" value={<span className="ios-red">{fmtMoney(pay.lateFeeAdded)}</span>} chevron={false} />}
              {Number(pay.planApplied ?? 0) > 0 && <Row title="To payment plan" value={fmtMoney(pay.planApplied)} chevron={false} />}
              {Number(pay.loanApplied ?? 0) > 0 && <Row title="Off the loan" value={fmtMoney(pay.loanApplied)} chevron={false} />}
              {pay.confirmationNumber && <Row title="Confirmation" value={pay.confirmationNumber} chevron={false} />}
              {pay.notes && <Row title={pay.notes} wrap chevron={false} />}
            </Section>
            {pay.breakdown && <div style={{ margin: '-12px 4px 20px' }}><PaymentBreakdownLine b={pay.breakdown} /></div>}
            <div style={{ display: 'grid', gap: 10 }}>
              <button className="ios-btn gray" onClick={() => { const p = pay; setPay(null); v.payment.edit(p); }}>Edit payment</button>
              <button className="ios-btn gray ios-red" disabled={v.payment.saving} onClick={() => { const p = pay; setPay(null); v.payment.remove(p); }}>Delete payment</button>
            </div>
          </>
        )}
      </Sheet>

      {/* Log or edit a payment: the same fields and rules as the desktop form. */}
      <Sheet open={v.payment.open} onClose={v.payment.close} title={v.payment.editing ? 'Edit payment' : 'Log payment'}
        right={{ label: v.payment.editing ? 'Save' : 'Log', onClick: v.payment.save, disabled: !v.payment.canSave, busy: v.payment.saving }}>
        <div className="ios-form-legacy">{v.payment.fields}</div>
      </Sheet>

      {/* The account itself. */}
      <Sheet open={actions} onClose={() => setActions(false)} title={account.providerName} left={null}
        right={{ label: 'Done', onClick: () => setActions(false) }}>
        <Section>
          <Row icon={categoryIcon(account.category)} title="Sync now" subtitle={account.lastSyncedAt ? `Last synced ${fmtDate(account.lastSyncedAt, 'MMM d, h:mm a')}` : undefined}
            value={v.syncing ? 'Syncing…' : undefined} onClick={() => { setActions(false); v.sync(); }} chevron={false} />
          <Row title="Bills every" chevron={false} value={
            <select className="ios-inline-select" aria-label="Billing cadence" value={account.billingCadence ?? 'MONTHLY'} onChange={e => v.setCadence(e.target.value)}>
              {Object.entries(CADENCE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>} />
          {v.lookupPage ? (
            <Row title="Name on the bill" subtitle="Sollux looks up the bills with it — no login" onClick={() => { setActions(false); editName(); }}
              value={<span className={account.lookupName ? '' : 'ios-tint'}>{account.lookupName || 'Add'}</span>} />
          ) : (
            <Row title="Portal login" subtitle="Sollux fetches statements from the provider's site" onClick={() => { setActions(false); v.openPortalLogin(); }}
              value={<span className={account.hasCredentials ? 'ios-green' : 'ios-tint'}>{account.hasCredentials ? 'Saved' : 'Add'}</span>} />
          )}
          <Row title="Website" chevron={false} onClick={() => { setActions(false); v.saveWebsite(); }}
            value={<span className="ios-tint">{v.siteLabel ?? 'Add'}</span>} />
          {account.accountNumber && (
            <Row title="Account number" chevron={false} onClick={v.revealNumber}
              value={<span style={{ fontVariantNumeric: 'tabular-nums' }}>{v.revealedNumber ?? account.accountNumber}</span>} />
          )}
        </Section>
        <Section>
          {!v.hasPlan && <Row title="Add a payment plan" subtitle="For arrears on an installment arrangement" onClick={() => { setActions(false); v.addPlan(); }} />}
          {!v.hasLoan && <Row title="Add loan details" subtitle="Interest rate, term, maturity" onClick={() => { setActions(false); v.addLoan(); }} />}
          <Row title="Add a statement by hand" onClick={() => { setActions(false); v.editStatement({}); }} />
        </Section>
        <Section footer={account.isActive === false ? 'Inactive accounts keep their history and are not synced.' : 'Deactivating keeps all history and pauses syncing.'}>
          <Row title={account.isActive === false ? 'Reactivate account' : 'Deactivate account'} chevron={false}
            onClick={() => { setActions(false); v.toggleActive(); }} tinted />
          <Row title="Delete account" destructive chevron={false} onClick={() => { setActions(false); v.remove(); }} />
        </Section>
      </Sheet>

      <Sheet open={nameSheet} onClose={() => setNameSheet(false)} title="Name on the bill"
        right={{ label: 'Save', busy: savingName, disabled: !name.trim() && !account.lookupName,
          onClick: () => { setSavingName(true); void v.saveLookupName(name).finally(() => { setSavingName(false); setNameSheet(false); }); } }}>
        <Section header={account.providerName} footer="Exactly as the bill prints it, e.g. JANE SMITH. Sollux types it with the account number into the provider's bill lookup page — no login needed.">
          <Field label="Name"><input autoCorrect="off" autoCapitalize="characters" placeholder="As on the bill" value={name} onChange={e => setName(e.target.value)} /></Field>
        </Section>
      </Sheet>

      {v.modals}
    </Screen>
  );
}

function BillDetail({ s, v, status, close }: { s: any; v: UtilityAccountView; status: { color: 'green' | 'amber' | 'red'; label: string }; close: () => void }) {
  const total = v.totalDueOf(s) ?? Number(s.amountDue ?? 0);
  const charge = Number(s.amountDue ?? 0);
  const pastDue = s.pastDueCarried != null ? Number(s.pastDueCarried) : null;
  const breakdown = (s.rawDataJson?.chargeBreakdown ?? {}) as Record<string, number>;
  const txns = (Array.isArray(s.rawDataJson?.transactions) ? s.rawDataJson.transactions : []) as { date: string; description: string; amount: number }[];
  const paid = v.isPaid(s);
  return (
    <>
      <div style={{ textAlign: 'center', margin: '8px 0 20px' }}>
        <div className={`ios-hero-value ${total < 0 ? 'ios-green' : ''}`}>{total < 0 ? `−${fmtMoney(-total)}` : fmtMoney(total)}</div>
        <div className="ios-hero-sub"><span className={TONE[status.color]}>{status.label}</span>{s.dueDate ? ` · due ${fmtDate(s.dueDate, 'MMM d, yyyy')}` : ''}</div>
      </div>
      <Section>
        {s.billingPeriodStart && s.billingPeriodEnd && <Row title="Service period" chevron={false} value={`${fmtDate(s.billingPeriodStart, 'MMM d')} – ${fmtDate(s.billingPeriodEnd, 'MMM d')}`} />}
        {s.statementDate && <Row title="Billed" chevron={false} value={fmtDate(s.statementDate, 'MMM d, yyyy')} />}
        {/* A payment-agreement installment billed inside this bill: shown on its own, as the bill prints it. */}
        {Number(s.paymentPlanAmount ?? 0) > 0 ? <>
          <Row title="Current charges" chevron={false} value={fmtMoney(charge - Number(s.paymentPlanAmount))} />
          <Row title="Payment agreement" chevron={false} value={<span className={paid ? '' : 'ios-blue-text'}>{fmtMoney(s.paymentPlanAmount)}</span>} />
        </> : <Row title="This bill's charge" chevron={false} value={fmtMoney(charge)} />}
        {pastDue != null && Math.abs(pastDue) > 0.005 && (
          <Row title={pastDue > 0 ? 'Past due carried in' : 'Credit carried in'} chevron={false}
            value={<span className={pastDue > 0 ? (paid ? '' : 'ios-red') : 'ios-green'}>{pastDue > 0 ? fmtMoney(pastDue) : `−${fmtMoney(-pastDue)}`}</span>} />
        )}
        {Number(s.penaltiesFees ?? 0) > 0 && <Row title="Penalties and fees" chevron={false} value={<span className="ios-red">{fmtMoney(s.penaltiesFees)}</span>} />}
        {s.penaltyDate && !paid && <Row title={new Date(s.penaltyDate) >= new Date() ? 'Penalty after' : 'Penalty assessed'} chevron={false} value={<span className="ios-tint">{fmtDate(s.penaltyDate, 'MMM d, yyyy')}</span>} />}
        {s.trueUpDeferred != null && Number(s.trueUpDeferred) !== 0 && <Row title="Deferred to true-up" chevron={false} value={fmtMoney(s.trueUpDeferred)} />}
        {s.usageValue && <Row title="Usage" chevron={false} value={`${s.usageValue} ${s.usageUnit ?? ''}`} />}
      </Section>
      {Object.keys(breakdown).length > 0 && (
        <Section header="Charges">
          {Object.entries(breakdown).map(([label, amt]) => (
            <Row key={label} title={label} chevron={false} value={<span className={Number(amt) < 0 ? 'ios-green' : ''}>{fmtMoney(Number(amt))}</span>} />
          ))}
        </Section>
      )}
      {txns.length > 0 && (
        <Section header="Transactions on the statement">
          {txns.map((t, i) => (
            <Row key={i} title={t.description} subtitle={fmtDate(t.date, 'MMM d')} chevron={false}
              value={<span className={Number(t.amount) < 0 ? 'ios-green' : ''}>{Number(t.amount) < 0 ? '−' : ''}{fmtMoney(Math.abs(Number(t.amount)))}</span>} />
          ))}
        </Section>
      )}
      {s.rawDataJson?.emailNotice && !s.pdfS3Key && <p className="ios-footnote">From the bill email · the statement PDF is not on file yet.</p>}
      <div style={{ display: 'grid', gap: 10 }}>
        {s.pdfS3Key && <button className="ios-btn gray" onClick={() => v.openPdf(s)}>View statement PDF</button>}
        {paid
          ? <button className="ios-btn gray" disabled={v.markingPaid === s.id} onClick={() => v.markUnpaid(s)}>{v.markingPaid === s.id ? 'Saving…' : 'Mark as unpaid'}</button>
          : <button className="ios-btn filled" disabled={v.markingPaid === s.id} onClick={() => v.markPaid(s)}>{v.markingPaid === s.id ? 'Saving…' : 'Mark as paid'}</button>}
        <button className="ios-btn gray" onClick={() => { close(); v.editStatement(s); }}>Edit statement</button>
      </div>
    </>
  );
}
