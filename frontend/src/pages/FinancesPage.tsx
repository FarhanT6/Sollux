import { Navigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import PnLPage from './PnLPage';
import CashflowPage from './CashflowPage';
import BudgetPage from './BudgetPage';
import LoansPage from './LoansPage';
import CostsPage from './CostsPage';
import IncomingPaymentsPage from './IncomingPaymentsPage';
import LoanPaymentTracker from '../components/loans/LoanPaymentTracker';

export type Tab = 'performance' | 'loans' | 'incoming' | 'costs';

interface View { key: string; label: string; subtitle: string; render: () => JSX.Element }

/**
 * The Finances sections: one list for the desktop tabs and the phone's index
 * (pages/phone/FinancesScreen.tsx), so both offer the same things. Four
 * sections, each with its views: P&L, cash flow and budget under
 * Performance; the loans and their month-by-month payments under Loans;
 * what each property cost, by type, under Costs (lib/costLedger on the
 * server). Utility payments, fees and the bill archive are on the Bills
 * page. Reconciliation and Expense Payments were taken out — the property
 * manager's monthly statement is to come in a better way.
 */
export const FINANCE_SECTIONS: { key: Tab; label: string; subtitle: string; views: View[] }[] = [
  {
    key: 'performance', label: 'Performance', subtitle: 'Income, costs and cash by property',
    views: [
      { key: 'pnl', label: 'P&L', subtitle: 'Net operating income and cash flow by property', render: () => <PnLPage embedded /> },
      { key: 'cashflow', label: 'Cash flow', subtitle: 'Rent received against the loans, and against the loans and utilities — per property, per month', render: () => <CashflowPage embedded /> },
      { key: 'budget', label: 'Budget', subtitle: 'The month: rent collected, delinquency, and what is left after loans and bills', render: () => <BudgetPage embedded /> },
    ],
  },
  {
    key: 'loans', label: 'Loans', subtitle: 'Mortgages, HELOCs and installment plans, and every payment on them',
    views: [
      { key: 'loans', label: 'Loans', subtitle: 'Mortgages, HELOCs, and installment plans', render: () => <LoansPage embedded /> },
      { key: 'loan-payments', label: 'Payments by month', subtitle: 'Every loan payment month by month — owed, paid, due, in grace or late', render: () => <LoanPaymentTracker /> },
    ],
  },
  {
    key: 'incoming', label: 'Incoming payments', subtitle: 'Transfers, checks and deposits into watched bank accounts, matched to tenants',
    views: [{ key: 'incoming', label: 'Incoming payments', subtitle: 'Transfers, checks and deposits into watched bank accounts, matched to tenants', render: () => <IncomingPaymentsPage embedded /> }],
  },
  {
    key: 'costs', label: 'Costs', subtitle: 'What each property cost, by type: utilities, insurance, tax, HOA, maintenance, management, loans',
    views: [{ key: 'costs', label: 'Costs', subtitle: 'What each property cost, by type: utilities, insurance, tax, HOA, maintenance, management, loans', render: () => <CostsPage /> }],
  },
];

/** Old ?tab= links (one tab per view) and where they live now. */
const OLD_TABS: Record<string, [Tab, string]> = {
  pnl: ['performance', 'pnl'], cashflow: ['performance', 'cashflow'], budget: ['performance', 'budget'],
  'loan-payments': ['loans', 'loan-payments'], reconciliation: ['performance', 'pnl'], outgoing: ['costs', 'costs'], expenses: ['costs', 'costs'],
};

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
  const toBills = billsRedirect(raw, searchParams.get('view'));
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
