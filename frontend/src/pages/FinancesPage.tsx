import { Navigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import FinanceOverviewPage from './FinanceOverviewPage';
import LoansPage from './LoansPage';
import CostsPage from './CostsPage';
import OperatingExpensesPage from './OperatingExpensesPage';
import IncomingPaymentsPage from './IncomingPaymentsPage';
import ManagerStatementsPage from './ManagerStatementsPage';
import LoanPaymentTracker from '../components/loans/LoanPaymentTracker';

export type Tab = 'overview' | 'costs' | 'loans' | 'income';

interface View { key: string; label: string; subtitle: string; render: () => JSX.Element }

/**
 * The Finances sections: one list for the desktop tabs and the phone's index
 * (pages/phone/FinancesScreen.tsx), so both offer the same things.
 *   Overview  rent against costs by type, NOI, loans and cash flow per month,
 *             actual beside expected (replaced P&L, cash flow and budget)
 *   Costs     what each property cost, by type (lib/costLedger on the server)
 *   Loans     every loan with this month's payment, and payments by month
 *   Income    rent collection and delinquency, incoming deposits, and the
 *             property manager's monthly statements, read and recorded
 * Utility payments, fees and the bill archive are on the Bills page.
 */
export const FINANCE_SECTIONS: { key: Tab; label: string; subtitle: string; views: View[] }[] = [
  {
    key: 'overview', label: 'P&L', subtitle: 'Rent, costs, NOI, loans and cash flow — month by month, against what was expected',
    views: [{ key: 'overview', label: 'Overview', subtitle: 'Rent, costs, NOI, loans and cash flow — month by month, against what was expected', render: () => <FinanceOverviewPage /> }],
  },
  {
    key: 'costs', label: 'Costs', subtitle: 'What each property cost, by type: utilities, insurance, tax, HOA, maintenance, management, loans',
    views: [
      { key: 'costs', label: 'By type', subtitle: 'What each property cost, by type: utilities, insurance, tax, HOA, maintenance, management, loans', render: () => <CostsPage /> },
      // Once its own page (Operating expenses): each property's running costs and what it nets, with estimates.
      { key: 'property', label: 'By property', subtitle: 'What each property costs to run, and what it nets', render: () => <OperatingExpensesPage embedded /> },
    ],
  },
  {
    key: 'loans', label: 'Loans', subtitle: 'Every loan, this month\'s payment on each, and every payment by month',
    views: [{
      key: 'loans', label: 'Loans', subtitle: 'Every loan, this month\'s payment on each, and every payment by month',
      render: () => (
        <>
          <LoansPage embedded />
          <h2 className="text-sm font-semibold text-white mt-8 mb-3">Payments by month</h2>
          <LoanPaymentTracker />
        </>
      ),
    }],
  },
  {
    // Rent itself (this month, who is behind) is under Properties -> Tenants & rent.
    key: 'income', label: 'Income', subtitle: 'Money coming in: transfers matched to tenants, and manager statements',
    views: [
      { key: 'incoming', label: 'Incoming payments', subtitle: 'Transfers, checks and deposits into watched bank accounts, matched to tenants', render: () => <IncomingPaymentsPage embedded /> },
      { key: 'manager', label: 'Manager statements', subtitle: 'Upload your property manager\'s monthly statement: rent, fees, repairs and loan payments read and recorded', render: () => <ManagerStatementsPage /> },
    ],
  },
];

/** Old ?tab= links (one tab per view) and where they live now. */
const OLD_TABS: Record<string, [Tab, string]> = {
  performance: ['overview', 'overview'], pnl: ['overview', 'overview'], cashflow: ['overview', 'overview'], budget: ['income', 'incoming'],
  'loan-payments': ['loans', 'loans'], incoming: ['income', 'incoming'],
  reconciliation: ['income', 'manager'], outgoing: ['costs', 'costs'], expenses: ['costs', 'costs'],
};

/** Rent moved to Properties -> Tenants & rent; old Finances links to it go there. */
export function rentRedirect(tab: string | null, view: string | null): string | null {
  return tab === 'budget' || (tab === 'income' && view === 'rent') ? '/tenants?tab=rent' : null;
}

/** Old Finances links to what is now on the Bills page. */
export const BILLS_VIEWS: Record<string, string> = { fees: 'fees', 'utility-payments': 'payments', bills: 'archive' };
export function billsRedirect(tab: string | null, view: string | null): string | null {
  const v = (tab && BILLS_VIEWS[tab]) || (tab === 'expenses' && view && BILLS_VIEWS[view]);
  return v ? `/bills?view=${v}` : null;
}

/** The section and view a ?tab=&view= pair names, old links included. */
export function resolveFinance(tab: string | null, view: string | null) {
  const [t, v] = tab && OLD_TABS[tab] ? OLD_TABS[tab] : [tab, view];
  const section = FINANCE_SECTIONS.find(x => x.key === t) ?? null;
  const current = section ? section.views.find(x => x.key === v) ?? section.views[0] : null;
  return { section, view: current };
}

/** The views of a section, as a row of small switches; none when it has one view. */
export function ViewSwitch({ views, value, onChange }: { views: View[]; value: string; onChange: (key: string) => void }) {
  if (views.length < 2) return null;
  return (
    <div className="inline-flex rounded-lg p-0.5 mb-4" style={{ background: 'rgba(255,255,255,0.05)' }}>
      {views.map(v => (
        <button key={v.key} onClick={() => onChange(v.key)}
          className={`text-xs px-3 py-1.5 rounded-md transition-colors ${value === v.key ? 'bg-white/10 text-white font-medium' : 'text-gray-400 hover:text-gray-200'}`}>
          {v.label}
        </button>
      ))}
    </div>
  );
}

export default function FinancesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');

  // Personal expenses moved to the Personal section.
  if (raw === 'personal') return <Navigate to="/personal?tab=expenses" replace />;
  const toBills = billsRedirect(raw, searchParams.get('view')) ?? rentRedirect(raw, searchParams.get('view'));
  if (toBills) return <Navigate to={toBills} replace />;

  const resolved = resolveFinance(raw, searchParams.get('view'));
  const section = resolved.section ?? FINANCE_SECTIONS[0];
  const view = resolved.view ?? section.views[0];
  const go = (tab: Tab, v?: string) => setSearchParams(v ? { tab, view: v } : { tab }, { replace: true });

  return (
    <div>
      <PageHeader title="Finances" subtitle={view.subtitle} />

      <div className="flex border-b px-6" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        {FINANCE_SECTIONS.map(t => (
          <button
            key={t.key}
            onClick={() => go(t.key)}
            className={`text-sm py-3 px-4 border-b-2 transition-colors ${
              section.key === t.key
                ? 'border-amber-400 text-amber-400 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="px-6 py-5">
        <ViewSwitch views={section.views} value={view.key} onChange={v => go(section.key, v)} />
        {view.render()}
      </div>
    </div>
  );
}
