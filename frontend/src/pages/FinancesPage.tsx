import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import PnLPage from './PnLPage';
import CashflowPage from './CashflowPage';
import BudgetPage from './BudgetPage';
import LoansPage from './LoansPage';
import ExpensesPage from './ExpensesPage';
import PersonalExpensesPage from './PersonalExpensesPage';
import ReconciliationPage from './ReconciliationPage';
import IncomingPaymentsPage from './IncomingPaymentsPage';
import OutgoingPaymentsPage from './OutgoingPaymentsPage';
import FeesSummaryPage from './FeesSummaryPage';
import PaymentsPage from './PaymentsPage';
import DocumentsPage from './DocumentsPage';

type Tab = 'pnl' | 'cashflow' | 'budget' | 'loans' | 'expenses' | 'personal' | 'reconciliation' | 'incoming' | 'outgoing' | 'fees' | 'utility-payments' | 'bills';

const TABS: { key: Tab; label: string }[] = [
  { key: 'pnl',            label: 'P&L'            },
  { key: 'cashflow',       label: 'Cash Flow'      },
  { key: 'budget',         label: 'Budget'         },
  { key: 'loans',          label: 'Loans'          },
  { key: 'expenses',       label: 'Expenses'       },
  { key: 'personal',       label: 'Personal Expenses' },
  { key: 'reconciliation', label: 'Reconciliation' },
  { key: 'incoming',       label: 'Incoming Payments' },
  { key: 'outgoing',       label: 'Expense Payments' },
  { key: 'fees',           label: 'Fees Summary' },
  { key: 'utility-payments', label: 'Utility Payments' },
  { key: 'bills',          label: 'Bill Archive'   },
];

export default function FinancesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') as Tab) || 'pnl';

  function setTab(t: Tab) {
    setSearchParams({ tab: t }, { replace: true });
  }

  const subtitles: Record<Tab, string> = {
    pnl:            'Net operating income and cash flow by property',
    cashflow:       'Rent received against the loans, and against the loans and utilities — per property, per month',
    budget:         'Monthly cash position, rent collection, and delinquency',
    loans:          'Mortgages, HELOCs, and installment plans',
    expenses:       'Operating and capital expenditures across all properties',
    personal:       'Auto loans, insurance, credit cards, and other non-property spending',
    reconciliation: 'Monthly statements from managers/collectors who net rent, fees, and loan payments together',
    incoming:       'Transfers, checks and deposits into watched bank accounts, matched to tenants',
    outgoing:       'Hardware-store purchases and utility bill payments matched to properties',
    fees:           'Any line item, broken down by utility and rolled up by property — month, year, or overall',
    'utility-payments': 'Payments made against utility accounts, grouped by provider',
    bills:          'Every statement across all properties, searchable, with PDFs',
  };

  return (
    <div>
      <PageHeader title="Finances" subtitle={subtitles[tab]} />

      <div className="flex border-b px-6" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        {TABS.map(t => (
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
        {tab === 'pnl'      && <PnLPage embedded />}
        {tab === 'cashflow' && <CashflowPage embedded />}
        {tab === 'budget'   && <BudgetPage embedded />}
        {tab === 'loans'    && <LoansPage embedded />}
        {tab === 'expenses' && <ExpensesPage embedded />}
        {tab === 'personal' && <PersonalExpensesPage embedded />}
        {tab === 'reconciliation' && <ReconciliationPage embedded />}
        {tab === 'incoming' && <IncomingPaymentsPage embedded />}
        {tab === 'outgoing' && <OutgoingPaymentsPage embedded />}
        {tab === 'fees' && <FeesSummaryPage embedded />}
        {tab === 'utility-payments' && <PaymentsPage embedded />}
        {tab === 'bills' && <DocumentsPage embedded />}
      </div>
    </div>
  );
}
