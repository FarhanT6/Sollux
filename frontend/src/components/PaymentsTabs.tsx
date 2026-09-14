import { Link } from 'react-router-dom';

/** The two views under Payments: which bills to pay first, and where the money comes from. */
export default function PaymentsTabs({ active }: { active: 'priorities' | 'plan' }) {
  const tab = (key: 'priorities' | 'plan', to: string, label: string) => (
    <Link to={to}
      className={`px-3 py-2 text-sm border-b-2 transition-colors ${active === key ? 'border-[#F5A623] text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
      {label}
    </Link>
  );
  return (
    <div className="px-6 flex gap-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
      {tab('plan', '/payments', 'Pay planner')}
      {tab('priorities', '/payments/priorities', 'Bills to pay first')}
    </div>
  );
}
