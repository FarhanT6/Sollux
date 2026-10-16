import { useState, type ReactNode } from 'react';
import { Screen, Section, Row, Segmented, Sheet, BarButton, Icon } from '../../ios';
import type { Loan } from '../../types';
import type { AmortizationResponse } from '../LoanDetailPage';
import { fmtDate } from '../../lib/date';

type Amort = AmortizationResponse['amortization'];
type ScheduleRow = Amort['schedule'][number];

const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2 = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

/**
 * A loan on a phone: the balance and how far it is paid off, the payment,
 * when it ends, then the schedule and the payments made. LoanDetailPage owns
 * the loan and its maths; this lays them out.
 */
export default function LoanScreen(p: {
  loan: Loan;
  amortization: Amort;
  balance: AmortizationResponse['balance'];
  typeLabel: string;
  methodLabel?: string;
  hasBalanceData: boolean;
  currentBalance: number;
  originalAmount: number;
  paidOff: number;
  reachesBalloonPayoff: boolean;
  lastRow?: ScheduleRow;
  peakRow?: ScheduleRow;
  warnings: ReactNode;
  chart: ReactNode;
  panels: ReactNode;
  modals: ReactNode;
  onEdit: () => void;
  onExtend?: () => void;
  onRefresh: () => Promise<unknown>;
}) {
  const { loan, amortization: a } = p;
  const [actions, setActions] = useState(false);
  const [view, setView] = useState<'upcoming' | 'past'>('upcoming');
  const [all, setAll] = useState(false);
  const pi = Number(loan.monthlyPayment ?? a.computedMonthlyPayment);
  const escrow = Number(loan.escrowAmount ?? 0);
  const above = p.currentBalance > p.originalAmount;
  const utility = (loan as any).utilityAccount as { id: string; providerName: string; propertyId?: string } | undefined;

  const rows = view === 'past' ? a.historicalSchedule : a.schedule;
  const visible = all ? rows : view === 'past' ? rows.slice(-12).reverse() : rows.slice(0, 12);

  return (
    <Screen title={loan.lender} back onRefresh={p.onRefresh}
      subtitle={[p.typeLabel, loan.property ? (loan.property.nickname || loan.property.address) : null, loan.isPersonal ? 'Personal' : null, !loan.isActive ? 'Closed' : null].filter(Boolean).join(' · ')}
      right={<BarButton label="Loan actions" onClick={() => setActions(true)}><Icon.Ellipsis /></BarButton>}>

      <div className="ios-card" style={{ marginBottom: 12 }}>
        <div className="ios-hero-label">Current balance</div>
        <div className={`ios-hero-value ${p.hasBalanceData ? '' : 'ios-muted'}`}>{p.hasBalanceData ? money(p.balance.balance) : '—'}</div>
        <div className="ios-hero-sub">{p.hasBalanceData ? p.methodLabel : 'No balance on file — add one under Edit'}</div>
        {p.originalAmount > 0 && p.hasBalanceData && (
          <>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--ios-fill)', marginTop: 14, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: above ? '100%' : `${p.paidOff}%`, background: above ? 'var(--ios-red)' : 'var(--ios-tint)', borderRadius: 3 }} />
            </div>
            <div className="ios-hero-sub" style={{ marginTop: 6 }}>
              {above ? <span className="ios-red">{money(p.currentBalance - p.originalAmount)} above the original {money(p.originalAmount)}</span>
                : `${p.paidOff.toFixed(1)}% paid off · ${money(p.originalAmount - p.currentBalance)} of ${money(p.originalAmount)}`}
            </div>
          </>
        )}
      </div>

      <div className="ios-chips" style={{ marginBottom: 20 }}>
        <div className="ios-chip"><div className="k">{escrow ? 'Monthly incl. escrow' : 'Monthly'}</div><div className="v">{money(pi + escrow)}</div>
          {escrow > 0 && <div className="k">{money(pi)} + {money(escrow)}</div>}</div>
        <div className="ios-chip">
          {a.negativeAmortization ? (<><div className="k">Balance</div><div className="v ios-red">Growing</div></>)
            : a.isInterestOnly ? (<><div className="k">Balance</div><div className="v ios-tint">Flat</div></>)
            : (<><div className="k">Paid off</div><div className="v ios-green">{a.payoffDate ? fmtDate(a.payoffDate, 'MMM yyyy') : '—'}</div>
              {a.monthsRemaining ? <div className="k">{a.monthsRemaining} payments left</div> : null}</>)}
        </div>
        <div className="ios-chip"><div className="k">Rate{loan.rateType === 'VARIABLE' ? ' (variable)' : ''}</div><div className="v">{loan.interestRate != null ? `${loan.interestRate}%` : '—'}</div></div>
        <div className="ios-chip"><div className="k">Interest left</div><div className="v">{money(a.totalInterestRemaining)}</div></div>
      </div>

      <div className="ios-embedded">{p.warnings}</div>

      <Section header="Details">
        {loan.dueDay && <Row title="Due" chevron={false} value={`Day ${loan.dueDay}${loan.gracePeriodDays ? ` · ${loan.gracePeriodDays}d grace` : ''}`} />}
        {loan.maturityDate && <Row title="Matures" chevron={false} value={`${fmtDate(loan.maturityDate, 'MMM d, yyyy')}${loan.loanExtensions?.length ? ` · extended ×${loan.loanExtensions.length}` : ''}`} />}
        {a.balloonAtMaturity != null && a.balloonAtMaturity > 0 && <Row title="Due at maturity" chevron={false} value={<span className="ios-tint">{money(a.balloonAtMaturity)}</span>} />}
        {/* Only a growing or interest-only loan ends in a lump sum; an ordinary
            schedule's last payment is just smaller. */}
        {(a.negativeAmortization || a.isInterestOnly) && p.reachesBalloonPayoff && p.lastRow && <Row title="Balloon" chevron={false} value={`${money(p.lastRow.paymentAmount)} · ${fmtDate(p.lastRow.date, 'MMM yyyy')}`} />}
        {loan.rateType === 'VARIABLE' && <Row title="Rate" chevron={false} value={`${loan.rateIndex ?? ''} ${loan.rateMargin != null && Number(loan.rateMargin) >= 0 ? '+' : ''}${loan.rateMargin ?? ''}%${loan.nextRateAdjustment ? ` · resets ${fmtDate(loan.nextRateAdjustment, 'MMM yyyy')}` : ''}`} />}
        {(loan.accountLast4 || loan.accountNumber) && <Row title="Account" chevron={false} value={loan.accountLast4 ? `•••${loan.accountLast4}` : loan.accountNumber} />}
        {a.totalInterestToDate > 0 && <Row title="Interest paid so far" chevron={false} value={money(a.totalInterestToDate)} />}
        {loan.property && <Row title="Property" to={`/portfolio/${loan.property.id}`} value={loan.property.nickname || loan.property.address} />}
        {utility?.propertyId && <Row title="Billed with" to={`/properties/${utility.propertyId}/utilities/${utility.id}`} value={utility.providerName} />}
        {!loan.dueDay && !loan.maturityDate && !loan.property && <Row title="Add the due day and maturity under Edit" chevron={false} />}
      </Section>

      <div className="ios-embedded" style={{ marginBottom: 20 }}>{p.panels}</div>
      <div className="ios-embedded" style={{ marginBottom: 20 }}>{p.chart}</div>

      {a.isAmortizing && a.schedule.length > 0 && (
        <>
          {a.historicalSchedule.length > 0 && (
            <Segmented<'upcoming' | 'past'> label="Schedule" value={view} onChange={v => { setView(v); setAll(false); }}
              options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Past' }]} />
          )}
          <Section header={view === 'past' ? 'Past months (calculated)' : a.negativeAmortization ? 'Projected balance' : 'Upcoming payments'}
            action={rows.length > 12 ? { label: all ? 'Show less' : `All ${rows.length}`, onClick: () => setAll(v => !v) } : undefined}
            footer={view === 'past' ? 'Worked out from the origination date, not from payment records.' : undefined}>
            {visible.map(r => (
              <Row key={r.paymentNumber} chevron={false} title={fmtDate(r.date, 'MMM yyyy')}
                subtitle={<><span className={r.principal < 0 ? 'ios-red' : 'ios-green'}>{r.principal < 0 ? `+${money2(-r.principal)}` : money2(r.principal)} principal</span> · {money2(r.interest)} interest</>}
                value={<><span className="strong">{money2(r.paymentAmount)}</span><span className="small">{money(r.balance)} left</span></>} />
            ))}
          </Section>
        </>
      )}

      <Section header="Payments made">
        {(loan.loanPayments?.length ?? 0) === 0 && <Row title="No payments recorded yet" chevron={false} />}
        {(loan.loanPayments ?? []).map(pm => (
          <Row key={pm.id} chevron={false} title={fmtDate(pm.date, 'MMM d, yyyy')}
            subtitle={pm.principal != null || pm.interest != null ? `${money2(pm.principal)} principal · ${money2(pm.interest)} interest` : undefined}
            value={<><span className="strong">{money2(Number(pm.amount))}</span>
              {pm.status !== 'PAID' && <span className={`small ${pm.status === 'PAST_DUE' ? 'ios-red' : 'ios-tint'}`}>{pm.status.replace('_', ' ').toLowerCase()}</span>}</>} />
        ))}
      </Section>

      {(loan.loanExtensions?.length ?? 0) > 0 && (
        <Section header="Extensions">
          {loan.loanExtensions!.map(x => (
            <Row key={x.id} chevron={false} title={`+${x.months} month${x.months !== 1 ? 's' : ''}`}
              subtitle={[x.previousMaturityDate ? `${fmtDate(x.previousMaturityDate, 'MMM yyyy')} → ${fmtDate(x.newMaturityDate, 'MMM yyyy')}` : null, x.notes].filter(Boolean).join(' · ')}
              value={fmtDate(x.extendedAt, 'MMM d, yyyy')} />
          ))}
        </Section>
      )}

      <Sheet open={actions} onClose={() => setActions(false)} title={loan.lender} left={null}
        right={{ label: 'Done', onClick: () => setActions(false) }}>
        <Section>
          <Row title="Edit loan" onClick={() => { setActions(false); p.onEdit(); }} />
          {p.onExtend && <Row title="Extend maturity" onClick={() => { setActions(false); p.onExtend!(); }} />}
        </Section>
      </Sheet>

      {p.modals}
    </Screen>
  );
}
