import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getBilling, type BillingSummary } from '../api/client';

/**
 * One line above every page when the plan needs attention: the trial's last
 * few days, a failed payment, or a lapsed plan (read-only until a plan is
 * chosen). Quiet otherwise, and hidden on the billing screen itself.
 */
export default function PlanBanner() {
  const [b, setB] = useState<BillingSummary | null>(null);
  const location = useLocation();
  useEffect(() => { getBilling().then(setB).catch(() => {}); }, [location.pathname === '/settings']);
  if (!b || (location.pathname === '/settings' && location.search.includes('tab=billing'))) return null;

  const daysLeft = b.trialEndsAt ? Math.max(0, Math.ceil((new Date(b.trialEndsAt).getTime() - Date.now()) / 86400000)) : null;
  const text =
    b.access === 'lapsed' ? (b.lapsedReason === 'trial_ended' ? 'Your free trial has ended — everything is still here, read-only.' : 'Your plan has ended — everything is still here, read-only.')
    : b.access === 'active' && b.status === 'past_due' ? 'Your last payment failed — update your card to keep your plan.'
    : b.access === 'trial' && daysLeft != null && daysLeft <= 3 ? `Your free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`
    : null;
  if (!text || !b.canManage) return null;

  const urgent = b.access === 'lapsed' || b.status === 'past_due';
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs"
      style={{ background: urgent ? 'rgba(239,68,68,0.12)' : 'rgba(245,166,35,0.12)', color: urgent ? '#fca5a5' : '#F5A623' }}>
      <span>{text}</span>
      <Link to="/settings?tab=billing" className="font-semibold whitespace-nowrap underline">Choose a plan</Link>
    </div>
  );
}
