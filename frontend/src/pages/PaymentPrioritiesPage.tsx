import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getPaymentPriorities, getFeeSummary, updateUtility,
  type AccountPriority, type FeeSummary,
} from '../api/client';
import { PageHeader, StatCard, Skeleton, EmptyState, Pill, Modal, Field, Input } from '../components/ui';
import { fmtDate } from '../lib/date';

/**
 * What to pay first when everything cannot be paid at once.
 *
 * Deliberately narrow. Finances → Fees already reports what fees were charged
 * and when; this does not repeat that. What was missing is the decision: given
 * several outstanding balances, which one costs the most to leave unpaid. That
 * depends on the provider's behaviour, not the size of the bill.
 */

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const BEHAVIOUR: Record<AccountPriority['feeBehaviour'], { text: string; color: 'red' | 'amber' | 'green' | 'gray' }> = {
  charges_every_time: { text: 'Charges a fee every time', color: 'red' },
  charges_sometimes:  { text: 'Sometimes charges a fee', color: 'amber' },
  never_charged:      { text: 'Never charged a fee', color: 'green' },
  unknown:            { text: 'Not enough history', color: 'gray' },
};

export default function PaymentPrioritiesPage() {
  const [priorities, setPriorities] = useState<AccountPriority[]>([]);
  const [fees, setFees] = useState<FeeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AccountPriority | null>(null);

  async function load() {
    setLoading(true);
    // Independent requests: one failing should not blank the other.
    const [p, f] = await Promise.allSettled([getPaymentPriorities(), getFeeSummary(12)]);
    if (p.status === 'fulfilled') setPriorities(p.value);
    if (f.status === 'fulfilled') setFees(f.value);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const owing = priorities.filter(p => p.balanceToCurrent > 0);
  const totalOwed = owing.reduce((s, p) => s + p.balanceToCurrent, 0);
  const atRisk = owing.filter(p =>
    p.daysUntilPenalty != null && p.daysUntilPenalty <= 7 && p.feeBehaviour !== 'never_charged');
  const exposure = atRisk.reduce((s, p) => s + (p.knownNextFee ?? p.averageFee), 0);
  const shutoffs = owing.filter(p => p.daysUntilShutoff != null && p.daysUntilShutoff <= 30);
  // Accounts that have never been penalised are the ones that can wait — the
  // other half of the question, and the one nobody usually has an answer to.
  const canWait = owing.filter(p => p.feeBehaviour === 'never_charged');

  return (
    <div>
      <PageHeader title="Payments" subtitle="What to pay first, and what waiting costs" />

      <div className="px-6 py-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <StatCard label="Owed right now" value={money(totalOwed)} sub={`${owing.length} account${owing.length === 1 ? '' : 's'}`} />
          <StatCard
            label="Fees at risk this week" value={money(exposure)}
            sub={atRisk.length > 0 ? `${atRisk.length} account${atRisk.length === 1 ? '' : 's'}` : 'Nothing due soon'}
            subColor={atRisk.length > 0 ? 'red' : 'green'}
          />
          <StatCard
            label="Safe to defer" value={canWait.length}
            sub={canWait.length > 0 ? `${money(canWait.reduce((s, p) => s + p.balanceToCurrent, 0))} owed` : 'None'}
            subColor={canWait.length > 0 ? 'green' : 'neutral'}
          />
          <StatCard
            label="Facing shutoff" value={shutoffs.length}
            sub={shutoffs.length > 0 ? 'within 30 days' : 'None recorded'}
            subColor={shutoffs.length > 0 ? 'red' : 'neutral'}
          />
        </div>

        {loading ? <Skeleton /> : owing.length === 0 ? (
          <EmptyState icon="✅" title="Nothing outstanding" body="No account has a balance to bring current." />
        ) : (
          <div className="space-y-2">
            {owing.map(p => {
              const b = BEHAVIOUR[p.feeBehaviour];
              const overdue = p.daysUntilPenalty != null && p.daysUntilPenalty < 0;
              return (
                <div key={p.accountId} className="rounded-xl px-4 py-3"
                  style={{
                    background: '#161616',
                    border: `1px solid ${overdue ? 'rgba(248,113,113,0.35)' : 'rgba(255,255,255,0.06)'}`,
                  }}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Link to={`/properties/${p.propertyId}/utilities/${p.accountId}`}
                        className="text-sm font-semibold text-white hover:text-[#F5A623]">
                        {p.providerName}{p.serviceLabel ? ` — ${p.serviceLabel}` : ''}
                      </Link>
                      <p className="text-xs text-gray-500">{p.propertyName}</p>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <Pill color={b.color}>{b.text}</Pill>
                        {p.billsSeen > 0 && p.feeBehaviour !== 'unknown' && (
                          <span className="text-xs text-gray-600">
                            {p.billsWithFees}/{p.billsSeen} bills · {money(p.totalFeesPaid)} in fees
                          </span>
                        )}
                      </div>
                      <ul className="mt-2 space-y-0.5">
                        {p.reasons.map((r, i) => <li key={i} className="text-xs text-gray-400">· {r}</li>)}
                      </ul>
                    </div>

                    <div className="text-right flex-shrink-0">
                      <p className="text-lg font-semibold text-white">{money(p.balanceToCurrent)}</p>
                      {p.pastDue > 0 && <p className="text-xs text-red-400">{money(p.pastDue)} past due</p>}
                      <p className="text-xs text-gray-600">{money(p.currentCharges)} this period</p>
                      {p.dueDate && <p className="text-xs text-gray-500 mt-1">Due {fmtDate(p.dueDate, 'MMM d')}</p>}
                      <button onClick={() => setEditing(p)}
                        className="text-xs text-gray-500 hover:text-[#F5A623] mt-1"
                        style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                        Payment rules
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {fees && fees.totalFeesPaid > 0 && (
          <p className="text-xs text-gray-500 mt-5">
            {money(fees.totalFeesPaid)} paid in fees across {fees.billsWithFees} bills in the last 12 months.
            {' '}<Link to="/finances?tab=fees" className="text-[#F5A623] hover:underline">See the full breakdown</Link>.
          </p>
        )}
      </div>

      {editing && (
        <PaymentRulesModal account={editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}

/**
 * Rules you know that the bills do not state.
 *
 * Fee behaviour is learned from history; a shutoff threshold appears only on a
 * disconnection notice, so it is entered rather than inferred. Anything set
 * here takes precedence over what history suggests.
 */
function PaymentRulesModal({ account, onClose, onSaved }: {
  account: AccountPriority; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    graceDays: '', lateFeeFixed: '', lateFeePercent: '', shutoffAfterDays: '', paymentRuleNotes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setSaving(true); setError('');
    try {
      // Blank clears a rule rather than leaving a stale one in place.
      const orNull = (v: string) => v.trim() === '' ? null : Number(v);
      await updateUtility(account.accountId, {
        graceDays: orNull(form.graceDays),
        lateFeeFixed: orNull(form.lateFeeFixed),
        lateFeePercent: orNull(form.lateFeePercent),
        shutoffAfterDays: orNull(form.shutoffAfterDays),
        paymentRuleNotes: form.paymentRuleNotes.trim() || null,
      } as any);
      onSaved();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Could not save these rules');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Payment rules — ${account.providerName}`} onClose={onClose}
      footer={
        <>
          <button className="btn text-xs" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary text-xs" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save rules'}
          </button>
        </>
      }>
      <p className="text-xs text-gray-400 mb-4">
        Fee behaviour is learned from this account's own bills. Anything set here overrides
        that — you know the policy, the history is only evidence of it.
      </p>

      <Field label="Days after the due date before a fee applies" hint="Leave blank to use what the bills show.">
        <Input type="number" min="0" value={form.graceDays}
          onChange={e => setForm(f => ({ ...f, graceDays: e.target.value }))} placeholder="e.g. 15" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Late fee (fixed)">
          <Input type="number" step="0.01" min="0" value={form.lateFeeFixed}
            onChange={e => setForm(f => ({ ...f, lateFeeFixed: e.target.value }))} placeholder="5.00" />
        </Field>
        <Field label="Late fee (% of balance)">
          <Input type="number" step="0.01" min="0" max="100" value={form.lateFeePercent}
            onChange={e => setForm(f => ({ ...f, lateFeePercent: e.target.value }))} placeholder="1.5" />
        </Field>
      </div>

      <Field label="Days past due before service is cut"
        hint="Never inferred — this appears only on a disconnection notice, so it has to be recorded by hand.">
        <Input type="number" min="0" value={form.shutoffAfterDays}
          onChange={e => setForm(f => ({ ...f, shutoffAfterDays: e.target.value }))} placeholder="e.g. 60" />
      </Field>

      <Field label="Notes">
        <Input value={form.paymentRuleNotes}
          onChange={e => setForm(f => ({ ...f, paymentRuleNotes: e.target.value }))}
          placeholder="e.g. calls before shutoff; reconnect fee $50" />
      </Field>

      {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
    </Modal>
  );
}
