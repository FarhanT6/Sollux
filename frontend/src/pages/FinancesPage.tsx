import { Navigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import PnLPage from './PnLPage';
import CashflowPage from './CashflowPage';
import BudgetPage from './BudgetPage';
import LoansPage from './LoansPage';
import ExpensesPage from './ExpensesPage';
import ReconciliationPage from './ReconciliationPage';
import IncomingPaymentsPage from './IncomingPaymentsPage';
import OutgoingPaymentsPage from './OutgoingPaymentsPage';
import FeesSummaryPage from './FeesSummaryPage';
import PaymentsPage from './PaymentsPage';
import DocumentsPage from './DocumentsPage';
import LoanPaymentTracker from '../components/loans/LoanPaymentTracker';

export type Tab = 'pnl' | 'cashflow' | 'budget' | 'loans' | 'loan-payments' | 'expenses' | 'personal' | 'reconciliation' | 'incoming' | 'outgoing' | 'fees' | 'utility-payments' | 'bills';

/**
 * The Finances sections: one list for the desktop tabs and the phone's index
 * (pages/phone/FinancesScreen.tsx), so both offer the same things.
 */
export const FINANCE_SECTIONS: { key: Exclude<Tab, 'personal'>; label: string; subtitle: string; group: string; render: () => JSX.Element }[] = [
  { key: 'pnl', label: 'P&L', group: 'Performance', subtitle: 'Net operating income and cash flow by property', render: () => <PnLPage embedded /> },
  { key: 'cashflow', label: 'Cash Flow', group: 'Performance', subtitle: 'Rent received against the loans, and against the loans and utilities — per property, per month', render: () => <CashflowPage embedded /> },
  { key: 'budget', label: 'Budget', group: 'Performance', subtitle: 'Monthly cash position, rent collection, and delinquency', render: () => <BudgetPage embedded /> },
  { key: 'loans', label: 'Loans', group: 'Debt', subtitle: 'Mortgages, HELOCs, and installment plans', render: () => <LoansPage embedded /> },
  { key: 'loan-payments', label: 'Loan Payments', group: 'Debt', subtitle: 'Every loan payment month by month — owed, paid, due, in grace or late', render: () => <LoanPaymentTracker /> },
  { key: 'incoming', label: 'Incoming Payments', group: 'Money in & out', subtitle: 'Transfers, checks and deposits into watched bank accounts, matched to tenants', render: () => <IncomingPaymentsPage embedded /> },
  { key: 'outgoing', label: 'Expense Payments', group: 'Money in & out', subtitle: 'Hardware-store purchases and utility bill payments matched to properties', render: () => <OutgoingPaymentsPage embedded /> },
  { key: 'reconciliation', label: 'Reconciliation', group: 'Money in & out', subtitle: 'Monthly statements from managers/collectors who net rent, fees, and loan payments together', render: () => <ReconciliationPage embedded /> },
  { key: 'expenses', label: 'Expenses', group: 'Spending', subtitle: 'Operating and capital expenditures across all properties', render: () => <ExpensesPage embedded /> },
  { key: 'fees', label: 'Fees Summary', group: 'Spending', subtitle: 'Any line item, broken down by utility and rolled up by property — month, year, or overall', render: () => <FeesSummaryPage embedded /> },
  { key: 'utility-payments', label: 'Utility Payments', group: 'Spending', subtitle: 'Payments made against utility accounts, grouped by provider', render: () => <PaymentsPage embedded /> },
  { key: 'bills', label: 'Bill Archive', group: 'Spending', subtitle: 'Every statement across all properties, searchable, with PDFs', render: () => <DocumentsPage embedded /> },
];

export default function FinancesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') as Tab) || 'pnl';

  function setTab(t: Tab) {
    setSearchParams({ tab: t }, { replace: true });
  }

  const section = FINANCE_SECTIONS.find(x => x.key === tab) ?? FINANCE_SECTIONS[0];

  // Personal expenses moved to the Personal section.
  if ((tab as string) === 'personal') return <Navigate to="/personal?tab=expenses" replace />;

  return (
    <div>
      <PageHeader title="Finances" subtitle={section.subtitle} />

      <div className="flex border-b px-6" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        {FINANCE_SECTIONS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`text-sm py-3 px-4 border-b-2 transition-colors ${
              tab === t.key
                ? 'border-amber-400 text-amber-400 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="px-6 py-5">
        {section.render()}
      </div>
    </div>
  );
}
