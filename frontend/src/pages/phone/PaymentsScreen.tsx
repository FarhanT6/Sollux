import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Screen, Section, Row, Segmented, Sheet } from '../../ios';
import { usePayPlan } from '../PayPlanPage';
import type { PayPlanObligation } from '../../types';
import { fmtMoney } from '../../lib/money';
import { fmtDate } from '../../lib/date';
import { openUrl } from '../../lib/native';

const whenText = (o: PayPlanObligation) =>
  o.daysUntil < 0 ? `${-o.daysUntil}d overdue` : o.daysUntil === 0 ? 'Due today' : o.daysUntil === 1 ? 'Due tomorrow' : `Due ${fmtDate(o.dueDate, 'MMM d')}`;

const KIND_ICON = (o: PayPlanObligation) => ({
  bg: o.status === 'SHORT' ? 'var(--ios-red)' : o.kind === 'LOAN' ? '#0a84ff' : '#f5a623',
  glyph: <span style={{ fontWeight: 700, fontSize: 13 }}>{o.kind === 'LOAN' ? 'L' : 'U'}</span>,
});

/**
 * Payments on a phone: what is due in the window, whether the accounts can
 * cover it, and for each bill where to pay it from — tap one for the details
 * and to mark it sent. The same plan and actions as the desktop page.
 */
export default function PaymentsScreen() {
  const { plan, loading, days, setDays, busy, load, acctLabel, markSent, due, sent, shortCount } = usePayPlan();
  const [open, setOpen] = useState<PayPlanObligation | null>(null);

  return (
    <Screen title="Payments" onRefresh={load}>
      <Segmented<string> label="Window" value={String(days)} onChange={v => setDays(Number(v))}
        options={[{ value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '30', label: '30 days' }]} />

      <div className="ios-card" style={{ marginBottom: 12 }}>
        <div className="ios-hero-label">Due in the next {days} days</div>
        <div className="ios-hero-value">{plan ? fmtMoney(plan.totals.due) : '—'}</div>
        <div className="ios-hero-sub">
          {!plan ? (loading ? 'Loading…' : '') : plan.totals.short > 0
            ? <span className="ios-red">{fmtMoney(plan.totals.short)} short · {shortCount} can't be covered</span>
            : <span className="ios-green">Covered · {fmtMoney(plan.totals.afterPlan)} left after paying</span>}
        </div>
      </div>
      <div className="ios-chips" style={{ marginBottom: 28 }}>
        <div className="ios-chip"><div className="k">Free in accounts</div><div className="v">{plan ? fmtMoney(plan.totals.spendable) : '—'}</div></div>
        <div className="ios-chip"><div className="k">Bills</div><div className="v">{due.length}</div></div>
        <div className="ios-chip"><div className="k">Already sent</div><div className="v">{plan ? fmtMoney(plan.totals.sent) : '—'}</div></div>
      </div>

      {(plan?.warnings.length ?? 0) > 0 && (
        <Section header={<span className="ios-tint">Check first</span>}>
          {plan!.warnings.map((w, i) => <Row key={i} title={w} wrap chevron={false} />)}
        </Section>
      )}

      <Section header="To pay" action={{ label: 'Pay first', to: '/payments/priorities' }}>
        {due.length === 0 && <Row title={loading ? 'Loading…' : 'Nothing due in this window'} chevron={false} />}
        {due.map(o => (
          <Row key={o.key} onClick={() => setOpen(o)} icon={KIND_ICON(o)}
            title={o.label}
            subtitle={<><span className={o.daysUntil < 0 || o.status === 'SHORT' ? 'ios-red' : o.daysUntil <= 2 ? 'ios-tint' : ''}>{whenText(o)}</span>{o.payFrom[0] ? ` · from ${acctLabel(o.payFrom[0].accountId)}` : o.status === 'SHORT' ? ' · not covered' : ''}</>}
            value={<span className="strong">{fmtMoney(o.amount)}</span>}
          />
        ))}
      </Section>

      {sent.length > 0 && (
        <Section header="Sent, waiting to clear">
          {sent.map(o => (
            <Row key={o.key} onClick={() => setOpen(o)} title={o.label} subtitle={whenText(o)}
              value={<><span>{fmtMoney(o.amount)}</span><span className="small ios-green">Sent</span></>} />
          ))}
        </Section>
      )}

      {plan && plan.accounts.length > 0 && (
        <Section header="Accounts" footer="Free = balance, less what is pending and the cushion you keep.">
          {plan.accounts.map(a => (
            <Row key={a.id} title={`${a.name}${a.last4 ? ` ••${a.last4}` : ''}`}
              subtitle={a.stale ? <span className="ios-tint">Balance not up to date</span> : `${fmtMoney(a.balance)} balance${a.pendingTotal ? ` · ${fmtMoney(a.pendingTotal)} pending` : ''}`}
              value={<span className="strong">{fmtMoney(a.spendable)}</span>} chevron={false} />
          ))}
        </Section>
      )}

      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.label} left={null}
        right={{ label: 'Done', onClick: () => setOpen(null) }}>
        {open && (
          <>
            <div style={{ textAlign: 'center', margin: '8px 0 20px' }}>
              <div className="ios-hero-value">{fmtMoney(open.amount)}</div>
              <div className={`ios-hero-sub ${open.daysUntil < 0 ? 'ios-red' : ''}`}>{whenText(open)} · {fmtDate(open.dueDate, 'EEEE, MMM d')}</div>
            </div>
            <Section header="Pay from">
              {open.payFrom.length === 0 && <Row title="No account has enough free" chevron={false} destructive />}
              {open.payFrom.map(p => <Row key={p.accountId} title={acctLabel(p.accountId)} value={fmtMoney(p.amount)} chevron={false} />)}
            </Section>
            {(open.reason || open.detail) && (
              <Section header="Why">
                <Row title={[open.detail, open.reason].filter(Boolean).join(' · ')} wrap chevron={false} />
              </Section>
            )}
            {open.howToPay && (
              <Section header="How to pay"><Row title={open.howToPay} wrap chevron={false} /></Section>
            )}
            <div style={{ display: 'grid', gap: 10 }}>
              {open.payUrl && <button className="ios-btn gray" onClick={() => void openUrl(open.payUrl!)}>Pay online</button>}
              {open.status !== 'SENT' && open.payFrom.length > 0 && (
                <button className="ios-btn filled" disabled={busy === open.key}
                  onClick={async () => { await markSent(open); setOpen(null); }}>
                  {busy === open.key ? 'Saving…' : 'Mark as sent'}
                </button>
              )}
              <Link to={open.link} className="ios-btn gray" style={{ textDecoration: 'none' }} onClick={() => setOpen(null)}>
                Open {open.kind === 'LOAN' ? 'loan' : 'account'}
              </Link>
            </div>
          </>
        )}
      </Sheet>
    </Screen>
  );
}
