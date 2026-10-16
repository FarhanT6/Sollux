import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { Screen, Section, Row, Sheet, BarButton, categoryIcon } from '../../ios';
import {
  getDashboardSummary, getInsights, getLeases, getRentPayments, getServiceNotices, resolveServiceNotice,
  type ServiceNotice,
} from '../../api/client';
import type { AIInsight, DashboardSummary, Lease, RentPayment } from '../../types';
import { fmtMoney } from '../../lib/money';
import { fmtDate, todayISO, localMonthKey, monthKey } from '../../lib/date';
import { monthRentDue } from '../../lib/rentDue';
import { countdown, KIND } from '../../components/UrgentNotices';
import AskSollux from '../../components/AskSollux';

const daysUntil = (iso: string) => Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(todayISO())) / 86400000);

/**
 * Overview on a phone: what needs doing today, in the order it matters —
 * shut-off notices, bills due, rent not in yet, then what Sollux noticed.
 */
export default function OverviewScreen() {
  const { user } = useUser();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [notices, setNotices] = useState<ServiceNotice[]>([]);
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [payments, setPayments] = useState<RentPayment[]>([]);
  const [askOpen, setAskOpen] = useState(false);

  const load = useCallback(() => Promise.all([
    getDashboardSummary().then(setSummary).catch(() => {}),
    getServiceNotices().then(setNotices).catch(() => setNotices([])),
    getInsights({ unread: true }).then(setInsights).catch(() => setInsights([])),
    getLeases({ status: 'ACTIVE' }).then(setLeases).catch(() => setLeases([])),
    getRentPayments().then(setPayments).catch(() => setPayments([])),
  ]), []);
  useEffect(() => { void load(); }, [load]);

  // Rent this month: what each lease owes for the month vs what went toward it.
  const ym = localMonthKey(new Date());
  const paidBy = new Map<string, number>();
  for (const p of payments) {
    if (p.status !== 'RECEIVED' || monthKey(p.periodDate) !== ym) continue;
    paidBy.set(p.leaseId, (paidBy.get(p.leaseId) ?? 0) + Number(p.amount) - Number(p.appliedToArrears ?? 0));
  }
  const rentRows = leases.map(l => {
    const due = monthRentDue(l, ym) + (l.rentCharges ?? []).filter(c => monthKey(c.periodDate) === ym).reduce((s, c) => s + Number(c.amount), 0);
    return { l, due, paid: paidBy.get(l.id) ?? 0 };
  });
  const expected = rentRows.reduce((s, r) => s + r.due, 0);
  const collected = rentRows.reduce((s, r) => s + Math.min(r.paid, r.due), 0);
  const unpaid = rentRows.filter(r => r.paid + 0.01 < r.due).sort((a, b) => (b.due - b.paid) - (a.due - a.paid));
  const dueSoon = summary?.billsDueSoonList ?? [];
  const hour = new Date().getHours();
  const greeting = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}${user?.firstName ? `, ${user.firstName}` : ''}`;

  async function resolve(n: ServiceNotice) {
    if (!confirm(`Mark the ${(KIND[n.kind] ?? 'notice').toLowerCase()} from ${n.provider ?? 'this provider'} as resolved?`)) return;
    await resolveServiceNotice(n.id);
    setNotices(ns => ns.filter(x => x.id !== n.id));
  }

  return (
    <Screen title="Overview" subtitle={greeting} onRefresh={load}
      right={<BarButton label="Ask Sollux" onClick={() => setAskOpen(true)}><Sparkle /></BarButton>}>

      {notices.length > 0 && (
        <Section header={<span className="ios-red">Needs attention</span>} footer="Swipe left on a notice once it is paid.">
          {notices.map(n => {
            const c = countdown(n);
            return (
              <Row key={n.id}
                to={n.utilityAccountId && n.propertyId ? `/properties/${n.propertyId}/utilities/${n.utilityAccountId}` : '/import'}
                icon={{ bg: 'var(--ios-red)', glyph: <span style={{ fontWeight: 700 }}>!</span> }}
                title={n.provider ?? 'Provider'}
                subtitle={<><span className="ios-red">{KIND[n.kind] ?? 'Notice'}</span>{' · '}<span className={c.urgent ? 'ios-red' : undefined}>{c.text}</span></>}
                value={n.amountDemanded != null ? <span className="strong">{fmtMoney(n.amountDemanded)}</span> : undefined}
                swipe={[{ label: 'Resolved', color: 'var(--ios-green)', onClick: () => void resolve(n) }]}
              />
            );
          })}
        </Section>
      )}

      <div className="ios-card" style={{ marginBottom: 12 }}>
        <div className="ios-hero-label">Bills this month</div>
        <div className="ios-hero-value">{summary ? fmtMoney(summary.monthlyTotal) : '—'}</div>
        <div className="ios-hero-sub">
          {summary ? `${summary.totalUtilityAccounts} accounts across ${summary.totalProperties} properties` : 'Loading…'}
        </div>
      </div>
      <div className="ios-chips" style={{ marginBottom: 28 }}>
        <Chip k="Rent collected" v={expected ? `${Math.round((collected / expected) * 100)}%` : '—'} sub={expected ? `${money0(collected)} of ${money0(expected)}` : undefined} />
        <Chip k="Due this week" v={String(summary?.billsDueSoon ?? '—')} />
        <Chip k="Open notices" v={String(notices.length)} tone={notices.length ? 'red' : undefined} />
        <Chip k="Insights" v={String(summary?.unreadInsights ?? '—')} />
      </div>

      <Section header="Due soon" action={{ label: 'Pay plan', to: '/payments' }}
        footer={dueSoon.length === 0 && summary ? 'Nothing due in the next week.' : undefined}>
        {dueSoon.length === 0 && <Row title={summary ? 'All clear' : 'Loading…'} chevron={false} />}
        {dueSoon.map(b => {
          const d = daysUntil(b.dueDate);
          return (
            <Row key={b.id} to={`/properties/${b.propertyId}/utilities/${b.accountId}`}
              icon={categoryIcon(b.category)} title={b.providerName} subtitle={b.propertyLabel}
              value={<>
                <span className="strong">{b.amountDue != null ? fmtMoney(b.amountDue) : '—'}</span>
                <span className={`small ${d < 0 ? 'ios-red' : d <= 2 ? 'ios-tint' : ''}`}>
                  {d < 0 ? `${-d}d late` : d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : fmtDate(b.dueDate, 'MMM d')}
                </span>
              </>}
            />
          );
        })}
      </Section>

      <Section header={`Rent · ${fmtDate(todayISO(), 'MMMM')}`} action={{ label: 'Tenants', to: '/portfolio' }}
        footer={leases.length ? `${fmtMoney(collected)} of ${fmtMoney(expected)} collected.` : undefined}>
        {leases.length === 0 && <Row title="No active leases" chevron={false} />}
        {leases.length > 0 && unpaid.length === 0 && <Row title="Everyone has paid" chevron={false} value={<span className="ios-green">✓</span>} />}
        {unpaid.map(({ l, due, paid }) => {
          const names = (l.leaseTenants ?? []).map(lt => lt.tenant.fullName).join(', ') || 'Tenant';
          const place = [l.unit?.property?.nickname || l.unit?.property?.address, l.unit?.unitLabel].filter(Boolean).join(' · ');
          const late = new Date().getDate() > (l.rentDueDay ?? 1);
          return (
            <Row key={l.id} to={`/portfolio/${l.unit?.property?.id ?? ''}`}
              icon={{ bg: late ? 'var(--ios-red)' : 'var(--ios-orange)', glyph: <span style={{ fontWeight: 600, fontSize: 13 }}>{initials(names)}</span> }}
              title={names} subtitle={place}
              value={<>
                <span className="strong">{fmtMoney(due - paid)}</span>
                <span className={`small ${late && paid === 0 ? 'ios-red' : ''}`}>{paid > 0 ? `${money0(paid)} paid` : late ? 'Overdue' : 'Due'}</span>
              </>}
            />
          );
        })}
      </Section>

      <Section header="Insights" action={insights.length ? { label: 'See all', to: '/insights' } : undefined}>
        {insights.length === 0 && <Row title="Nothing new" chevron={false} />}
        {insights.slice(0, 4).map(i => (
          <Row key={i.id} to="/insights" wrap
            icon={{ bg: i.severity === 'ALERT' ? 'var(--ios-red)' : i.severity === 'WARNING' ? 'var(--ios-orange)' : 'var(--ios-blue)', glyph: <span style={{ fontWeight: 700 }}>{i.severity === 'INFO' ? 'i' : '!'}</span> }}
            title={i.title} subtitle={i.property?.nickname || i.property?.address}
          />
        ))}
      </Section>

      <Sheet open={askOpen} onClose={() => setAskOpen(false)} title="Ask Sollux" left={null} right={{ label: 'Done', onClick: () => setAskOpen(false) }}>
        <AskSollux />
      </Sheet>
    </Screen>
  );
}

function Chip({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: 'red' }) {
  return (
    <div className="ios-chip">
      <div className="k">{k}</div>
      <div className={`v${tone === 'red' ? ' ios-red' : ''}`}>{v}</div>
      {sub && <div className="k" style={{ marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

const money0 = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const initials = (s: string) => s.split(/[\s,]+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join('');

const Sparkle = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </svg>
);
