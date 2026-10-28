import axios from 'axios';
import { toast } from '../lib/toast';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
});

// The app's first requests can go out before Clerk has finished starting,
// with no token at all. Wait for it (briefly) so they are signed.
async function clerkReady(): Promise<any> {
  // @ts-ignore — Clerk is loaded globally via ClerkProvider
  const C = () => window.Clerk;
  for (let i = 0; i < 50 && !C()?.loaded; i++) await new Promise(r => setTimeout(r, 100));
  return C();
}

api.interceptors.request.use(async (config) => {
  try {
    const clerk = await clerkReady();
    const token = await clerk?.session?.getToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  } catch { /* no-op */ }
  return config;
});

// A 401 is usually a session token that went stale while the app sat in the
// background: get a fresh one and try once more. Only when there is no
// session at all does the owner need to sign in again.
api.interceptors.response.use(
  res => res,
  async err => {
    const cfg = err.config as (typeof err.config & { _retried?: boolean }) | undefined;
    if (err.response?.status === 401 && cfg && !cfg._retried) {
      cfg._retried = true;
      try {
        const clerk = await clerkReady();
        const token = await clerk?.session?.getToken({ skipCache: true });
        if (token) {
          cfg.headers = { ...(cfg.headers ?? {}), Authorization: `Bearer ${token}` } as any;
          return api.request(cfg);
        }
      } catch { /* fall through */ }
      if (!window.location.pathname.startsWith('/sign-in')) window.location.href = '/sign-in';
    }
    // A plan limit or a lapsed plan: say so where it happened.
    if (err.response?.status === 402) toast(err.response.data?.error ?? 'Choose a plan to continue.', 'error');
    // A tenant's sign-in opened an owner page: their place is the tenant portal.
    if (err.response?.status === 403 && err.response.data?.code === 'TENANT' && !window.location.pathname.startsWith('/portal')) {
      window.location.href = '/portal';
      return new Promise(() => {}); // the page is going away; nothing should toast meanwhile
    }
    // A page that could not load something says so, wherever it happens;
    // saves and deletes report their own errors where they were made.
    const method = (err.config?.method ?? 'get').toLowerCase();
    // Only real failures: a 4xx is an answer the page itself handles (a
    // deleted record, a bad link), not something that "didn't load".
    const status = err.response?.status;
    if (method === 'get' && (!status || status >= 500) && !String(err.config?.url ?? '').startsWith('/telemetry')) {
      toast(err.response ? "Something didn't load. Pull down or reopen the page to try again." : "You're offline or the server didn't answer. Try again in a moment.", 'error');
    }
    return Promise.reject(err);
  }
);

export default api;

import type {
  Property, UtilityAccount, Statement, StatementSummaryRow, Payment, AIInsight, DashboardSummary,
  Unit, Tenant, LeaseTenant, Lease, LeaseDeposit, RentPayment, RentNotice, RentChange, ScheduledRentIncrease, LeaseUtilityCharge, Expense, Loan, LoanComponent, LoanPayment,
  InsurancePolicy, TaxAssessment, TaxDefault, TaxCalendarInfo, TaxTimeline, Improvement, LegalMatter, PropertyPnL, MonthlyPnL,
  ComplianceItem, DevelopmentProject, ProjectTransfer,
  BankAccount, PendingOutflow, PendingOutflowKind, PayPlan, OtherIncome, BudgetSummary, DelinquencyTenant, BudgetForecast, IndexRate,
  ReconciliationProfile, ReconciliationStatement, ReconciliationLineItem,
  Document, DocumentClassification, DocumentMatch, DocumentCategory,
  IncomingTransaction, IncomingTransactionStatus, OutgoingTransaction, UtilityCandidate,
  TurnoverReport, LeasePaymentAlias, LegalEvent, LegalFee, LegalSummary,
} from '../types';

// Dashboard
export const getDashboardSummary = () =>
  api.get<DashboardSummary>('/dashboard/summary').then(r => r.data);
export const getRecentActivity = () =>
  api.get('/dashboard/recent-activity').then(r => r.data);

// Properties
export const getProperties = () =>
  api.get<Property[]>('/properties').then(r => r.data);
export const getProperty = (id: string) =>
  api.get<Property>(`/properties/${id}`).then(r => r.data);
export const createProperty = (data: Partial<Property>) =>
  api.post<Property>('/properties', data).then(r => r.data);
export const updateProperty = (id: string, data: Partial<Property>) =>
  api.patch<Property>(`/properties/${id}`, data).then(r => r.data);
export const deleteProperty = (id: string) =>
  api.delete(`/properties/${id}`);
/** Move everything on `id` to `targetId`, then delete `id`. */
export const mergeProperty = (id: string, targetId: string) =>
  api.post<{ ok: true; targetId: string; moved: Record<string, number> }>(`/properties/${id}/merge`, { targetId }).then(r => r.data);
export const lookupPropertyByAddress = (params: { address: string; city: string; state: string; zip?: string }) =>
  api.get<{
    record: {
      zipCode?: string; county?: string; propertyType?: string; bedrooms?: number; bathrooms?: number;
      squareFootage?: number; lotSize?: number; yearBuilt?: number;
      lastSaleDate?: string; lastSalePrice?: number;
    } | null;
    valuation: { price?: number; priceRangeLow?: number; priceRangeHigh?: number } | null;
  }>('/properties/lookup', { params }).then(r => r.data);

// Units
export const getUnits = (params?: { propertyId?: string; history?: string }) =>
  api.get<Unit[]>('/units', { params }).then(r => r.data);
export const createUnit = (data: Partial<Unit>) =>
  api.post<Unit>('/units', data).then(r => r.data);
export const updateUnit = (id: string, data: Partial<Unit>) =>
  api.patch<Unit>(`/units/${id}`, data).then(r => r.data);
export const deleteUnit = (id: string) =>
  api.delete(`/units/${id}`);

// Tenants
export const getTenants = () =>
  api.get<Tenant[]>('/tenants').then(r => r.data);
export const getTenant = (id: string) =>
  api.get<Tenant & { leaseTenants: (LeaseTenant & { lease: Lease })[] }>(`/tenants/${id}`).then(r => r.data);
export const createTenant = (data: Partial<Tenant>) =>
  api.post<Tenant>('/tenants', data).then(r => r.data);
export const updateTenant = (id: string, data: Partial<Tenant>) =>
  api.patch<Tenant>(`/tenants/${id}`, data).then(r => r.data);
export const deleteTenant = (id: string) =>
  api.delete(`/tenants/${id}`);

// Leases
export const getLeases = (params?: { propertyId?: string; status?: string }) =>
  api.get<Lease[]>('/leases', { params }).then(r => r.data);
export const getLease = (id: string) =>
  api.get<Lease>(`/leases/${id}`).then(r => r.data);
export const createLease = (data: any) =>
  api.post<Lease>('/leases', data).then(r => r.data);
export const updateLease = (id: string, data: any) =>
  api.patch<Lease>(`/leases/${id}`, data).then(r => r.data);
export const deleteLease = (id: string) =>
  api.delete(`/leases/${id}`);
// Utility reimbursement paid by a tenant, matched to the bills it covers.
export interface ReimbursableItem {
  key: string; utilityAccountId: string | null; statementId: string | null; category: string;
  label: string; periodDate: string; period: string; billAmount: number; sharePercent: number | null;
  owed: number; paid: number; outstanding: number; invoiceId: string | null;
}
export interface ReimbursementPaymentRow {
  id: string; leaseId: string; amount: number; paidDate: string; method: string; notes: string | null;
  bankAccount?: { id: string; name: string; bank?: string | null; last4?: string | null } | null;
  allocations: { id: string; statementId: string | null; utilityAccountId: string | null; category: string; periodDate: string; amount: number }[];
}
export interface OpenInvoice { id: string; periodStart: string; periodEnd: string; total: number; paidAmount: number; outstanding: number; status: string }
export interface ReimbursableBills { invoices: OpenInvoice[]; items: ReimbursableItem[] }
export const getReimbursableItems = (leaseId: string) =>
  api.get<ReimbursableBills>(`/reimbursements/lease/${leaseId}/owed`).then(r => r.data);
export const getInvoicePayments = (invoiceId: string) =>
  api.get<{ lines: Record<string, number>; payments: { id: string; paidDate: string; method: string; amount: number }[]; earlier: number }>(`/reimbursements/invoices/${invoiceId}/payments`).then(r => r.data);
export const getReimbursementPayments = (leaseId: string) =>
  api.get<ReimbursementPaymentRow[]>(`/reimbursements/lease/${leaseId}/payments`).then(r => r.data);
export const createReimbursementPayment = (leaseId: string, data: {
  amount: number; paidDate: string; method: string; bankAccountId?: string | null; notes?: string | null;
  allocations: { key: string; amount: number }[]; invoiceId?: string | null;
}) => api.post(`/reimbursements/lease/${leaseId}/payments`, data).then(r => r.data);
export const deleteReimbursementPayment = (id: string) =>
  api.delete(`/reimbursements/payments/${id}`);

/** Waive a late fee charged on a month. */
export const waiveRentCharge = (leaseId: string, chargeId: string) =>
  api.delete(`/leases/${leaseId}/charges/${chargeId}`);
export const uploadLeaseDocument = (id: string, fileData: string, filename: string) =>
  api.post<Lease>(`/leases/${id}/document`, { fileData, filename }).then(r => r.data);
export const getLeaseDocumentUrl = (id: string) =>
  api.get<{ url: string; expiresIn: number }>(`/leases/${id}/document`).then(r => r.data);
export const getRentChanges = (leaseId: string) =>
  api.get<RentChange[]>(`/leases/${leaseId}/rent-changes`).then(r => r.data);
export const addRentChange = (leaseId: string, data: { effectiveDate: string; previousAmount?: number | null; newAmount: number; note?: string | null }) =>
  api.post<RentChange>(`/leases/${leaseId}/rent-changes`, data).then(r => r.data);
export const deleteRentChange = (leaseId: string, changeId: string) =>
  api.delete(`/leases/${leaseId}/rent-changes/${changeId}`);
export const getLeaseDocuments = (leaseId: string) =>
  api.get<Document[]>(`/leases/${leaseId}/documents`).then(r => r.data);
export const addLeaseDocument = (leaseId: string, data: { fileData: string; filename?: string; category: string; title?: string; notes?: string }) =>
  api.post<Document>(`/leases/${leaseId}/documents`, data).then(r => r.data);
export const getLeaseDocumentViewUrl = (leaseId: string, docId: string) =>
  api.get<{ url: string }>(`/leases/${leaseId}/documents/${docId}/url`).then(r => r.data);
export interface LeasePerson { fullName: string; email: string | null; phone: string | null; address: string | null }
export interface LeaseRentStep { effectiveDate: string; amount: number | null; percent: number | null; recurring: boolean; note: string | null }
export interface LeaseUtilityTerm { category: string; amount: number; note: string | null }
/** Everything else read from a lease agreement; saved as the lease's summary (termsJson). */
export interface LeaseDetails {
  leaseDate: string | null; premises: string | null; unitLabel: string | null; use: string | null;
  landlord: { name: string | null; signer: string | null; payTo: string | null; payToAddress: string | null; phone: string | null; email: string | null } | null;
  guarantors: LeasePerson[]; depositIncreasesWithRent: boolean | null; lateInterestPercent: number | null; nsfFee: number | null;
  utilities: string | null; operatingExpenses: string | null; propertyTaxes: string | null; maintenance: string | null;
  insurance: string | null; parking: string | null; storage: string | null; earlyPossession: string | null;
  renewal: string | null; afterTerm: string | null; condition: string | null;
  moveInCosts: { label: string; amount: number; dueDate: string | null }[]; otherTerms: string[];
  /** Set when saved: the agreement it came from, and the rent schedule as written. */
  source?: string | null; rentSchedule?: LeaseRentStep[]; utilityCharges?: LeaseUtilityTerm[];
}
export interface ExtractedLeaseTerms {
  startDate: string | null; endDate: string | null; rentAmount: number | null;
  securityDeposit: number | null; leaseType: 'FIXED_TERM' | 'MONTH_TO_MONTH' | null;
  rentDueDay: number | null; lateFeeAmount: number | null; lateFeePercent: number | null;
  lateFeeGraceDays: number | null; tenantNames: string[]; businessName: string | null; notes: string | null;
  firstMonthRent: number | null;
  tenants: LeasePerson[]; rentSchedule: LeaseRentStep[]; utilityCharges: LeaseUtilityTerm[]; details: LeaseDetails;
}
/** Read a lease agreement before the lease exists (New lease form). */
export const extractLeaseTermsFromFile = (fileData: string, filename: string) =>
  api.post<ExtractedLeaseTerms>('/leases/extract-terms', { fileData, filename }, { timeout: 180000 }).then(r => r.data);
export const extractLeaseTerms = (leaseId: string, fileData: string, filename: string) =>
  api.post<ExtractedLeaseTerms>(`/leases/${leaseId}/extract-terms`, { fileData, filename }, { timeout: 180000 }).then(r => r.data);
export const deleteLeaseAgreement = (leaseId: string) =>
  api.delete(`/leases/${leaseId}/document`);
export const deleteLeaseDocument = (leaseId: string, docId: string) =>
  api.delete(`/leases/${leaseId}/documents/${docId}`);
export const addScheduledIncrease = (leaseId: string, data: { effectiveDate: string; newAmount?: number | null; percent?: number | null; percentMax?: number | null; note?: string | null }) =>
  api.post<ScheduledRentIncrease>(`/leases/${leaseId}/scheduled-increases`, data).then(r => r.data);
export const applyScheduledIncrease = (leaseId: string, sid: string, override?: { percent?: number; amount?: number }) =>
  api.post<ScheduledRentIncrease>(`/leases/${leaseId}/scheduled-increases/${sid}/apply`, override || {}).then(r => r.data);
export const deleteScheduledIncrease = (leaseId: string, sid: string) =>
  api.delete(`/leases/${leaseId}/scheduled-increases/${sid}`);
export const addLeaseDeposit = (leaseId: string, data: { amount: number; paidDate: string; method?: string; bankAccountId?: string | null; notes?: string | null }) =>
  api.post<LeaseDeposit>(`/leases/${leaseId}/deposits`, data).then(r => r.data);
export const deleteLeaseDeposit = (leaseId: string, depositId: string) =>
  api.delete(`/leases/${leaseId}/deposits/${depositId}`);
export const addPaymentAlias = (leaseId: string, data: { name: string; note?: string }) =>
  api.post<LeasePaymentAlias>(`/leases/${leaseId}/payment-aliases`, data).then(r => r.data);
export const deletePaymentAlias = (leaseId: string, aliasId: string) =>
  api.delete(`/leases/${leaseId}/payment-aliases/${aliasId}`);
export const addLeaseUtilityCharge = (leaseId: string, data: { category: string; amount: number; note?: string | null }) =>
  api.post<LeaseUtilityCharge>(`/leases/${leaseId}/utility-charges`, data).then(r => r.data);
export const deleteLeaseUtilityCharge = (leaseId: string, chargeId: string) =>
  api.delete(`/leases/${leaseId}/utility-charges/${chargeId}`);

// Rent payments
export const getRentPayments = (params?: { leaseId?: string; propertyId?: string }) =>
  api.get<RentPayment[]>('/rent-payments', { params }).then(r => r.data);
export const createRentPayment = (data: any) =>
  api.post<RentPayment>('/rent-payments', data).then(r => r.data);
export const updateRentPayment = (id: string, data: any) =>
  api.patch<RentPayment>(`/rent-payments/${id}`, data).then(r => r.data);
export const deleteRentPayment = (id: string) =>
  api.delete(`/rent-payments/${id}`);

// Notices
export const getNotices = (params?: { leaseId?: string; propertyId?: string }) =>
  api.get<RentNotice[]>('/notices', { params }).then(r => r.data);
export const getNotice = (id: string) =>
  api.get<RentNotice>(`/notices/${id}`).then(r => r.data);
export const getNoticePreview = (leaseId: string) =>
  api.get<{ lineItems: { amount: number; dueDate: string }[]; totalDue: number }>(`/notices/preview/${leaseId}`).then(r => r.data);
export const createNotice = (data: any) =>
  api.post<RentNotice>('/notices', data).then(r => r.data);
export const deleteNotice = (id: string) =>
  api.delete(`/notices/${id}`);

// Expenses
export const getExpenses = (params?: { propertyId?: string; isCapEx?: boolean; isPersonal?: boolean }) =>
  api.get<Expense[]>('/expenses', { params }).then(r => r.data);
export const createExpense = (data: Partial<Expense>) =>
  api.post<Expense>('/expenses', data).then(r => r.data);
export const updateExpense = (id: string, data: Partial<Expense>) =>
  api.patch<Expense>(`/expenses/${id}`, data).then(r => r.data);
export const deleteExpense = (id: string) =>
  api.delete(`/expenses/${id}`);

// Loans
export const getLoans = (params?: { propertyId?: string; isPersonal?: boolean; isActive?: boolean }) =>
  api.get<Loan[]>('/loans', { params }).then(r => r.data);
export const getLoan = (id: string) =>
  api.get<Loan>(`/loans/${id}`).then(r => r.data);
export const getLoanAmortization = (id: string) =>
  api.get(`/loans/${id}/amortization`).then(r => r.data);
export const createLoan = (data: Partial<Loan>) =>
  api.post<Loan>('/loans', data).then(r => r.data);
export const updateLoan = (id: string, data: Partial<Loan>) =>
  api.patch<Loan>(`/loans/${id}`, data).then(r => r.data);
export const deleteLoan = (id: string) =>
  api.delete(`/loans/${id}`);
export const getLoanPayments = (loanId: string) =>
  api.get<LoanPayment[]>(`/loans/${loanId}/payments`).then(r => r.data);
export const createLoanPayment = (loanId: string, data: Partial<LoanPayment> & { periodMonth?: string | null }) =>
  api.post<LoanPayment>(`/loans/${loanId}/payments`, data).then(r => r.data);
export const extendLoan = (id: string, data: { months: number; notes?: string }) =>
  api.post<Loan>(`/loans/${id}/extend`, data).then(r => r.data);
// Monthly loan-payment tracker — the loans' side of rent collection.
export type LoanTrackerStatus = 'paid' | 'partial' | 'upcoming' | 'due' | 'late' | 'none';
interface LoanTrackerBase {
  loanId: string; lender: string; loanType: string; isPersonal: boolean; property: string; propertyId: string | null;
  expected: number; dueDay: number | null; gracePeriodDays: number | null;
  paymentMethods: string[]; paymentInstructions: string | null; mailingAddress: string | null; paymentUrl: string | null; payFrom: string | null;
}
export interface LoanTrackerPayment { id: string; loanId: string; date: string; month: string; amount: number; lateFee: number | null; method: string | null; confirmationNumber: string | null; notes: string | null }
export interface LoanTrackerRow extends LoanTrackerBase {
  dueDate: string; graceEnds: string; paid: number; remaining: number; lateFees: number; status: LoanTrackerStatus;
  payments: LoanTrackerPayment[]; lastPayment: { date: string; amount: number } | null;
}
export interface LoanTrackerMonth { month: string; rows: LoanTrackerRow[]; totals: { expected: number; paid: number; remaining: number; late: number } }
export interface LoanTrackerYear {
  year: number; months: string[];
  rows: (LoanTrackerBase & { cells: { month: string; expected: number; paid: number; status: LoanTrackerStatus }[]; paidYear: number; lateMonths: number })[];
}
export const getLoanTrackerMonth = (month: string, today: string) =>
  api.get<LoanTrackerMonth>('/loans/tracker', { params: { month, today } }).then(r => r.data);
export const getLoanTrackerYear = (year: number, today: string) =>
  api.get<LoanTrackerYear>('/loans/tracker', { params: { year, today } }).then(r => r.data);

// Payment details read from the owner's loan sheet, matched to existing loans.
export interface LoanSheetRow {
  lender: string; accountNumber: string | null; paymentAmount: number | null; propertyAddress: string | null;
  dueDay: number | null; gracePeriodDays: number | null; paymentMethods: string[]; paymentInstructions: string | null;
  mailingAddress: string | null; payeeBankName: string | null; payeeAccountLast4: string | null; paymentUrl: string | null;
}
export interface LoanSheetRead {
  rows: { row: LoanSheetRow; loanId: string | null }[];
  loans: { id: string; lender: string; property: string | null; monthlyPayment: number | null; accountLast4: string | null }[];
}
export const readLoanPaymentDetails = (files: FilePayload[]) =>
  api.post<LoanSheetRead>('/loans/payment-details/read', { files }, { timeout: 180000 }).then(r => r.data);
export const applyLoanPaymentDetails = (items: { loanId: string; row: LoanSheetRow }[]) =>
  api.post<{ updated: number }>('/loans/payment-details/apply', { items }).then(r => r.data);

// Reconciliation (e.g. a property manager who nets rent, a management fee,
// and unrelated loan payments together in one monthly statement)
export const getReconciliationProfiles = () =>
  api.get<ReconciliationProfile[]>('/reconciliation/profiles').then(r => r.data);
export const createReconciliationProfile = (data: Partial<ReconciliationProfile>) =>
  api.post<ReconciliationProfile>('/reconciliation/profiles', data).then(r => r.data);
export const deleteReconciliationProfile = (id: string) =>
  api.delete(`/reconciliation/profiles/${id}`);
export const getReconciliationStatements = (profileId?: string) =>
  api.get<ReconciliationStatement[]>('/reconciliation/statements', { params: profileId ? { profileId } : undefined }).then(r => r.data);
export const createReconciliationStatement = (data: {
  profileId: string; statementDate: string; lineItems: ReconciliationLineItem[]; notes?: string;
}) => api.post<ReconciliationStatement>('/reconciliation/statements', data).then(r => r.data);
export const uploadReconciliationDocument = (statementId: string, fileData: string, filename: string) =>
  api.post<ReconciliationStatement>(`/reconciliation/statements/${statementId}/document`, { fileData, filename }).then(r => r.data);
export const applyReconciliationStatement = (id: string) =>
  api.post<ReconciliationStatement>(`/reconciliation/statements/${id}/apply`).then(r => r.data);
export const deleteReconciliationStatement = (id: string) =>
  api.delete(`/reconciliation/statements/${id}`);

// Shared ("family") account access
export interface AccountMember { id: string; email: string; fullName: string; phone?: string | null; createdAt?: string }
export interface AccountInvite { id: string; email?: string | null; phone?: string | null; createdAt: string }
export interface AccountInfo {
  owner: AccountMember | null;
  members: AccountMember[];
  pendingInvites: AccountInvite[];
  me: { id: string; email: string; fullName: string; phone?: string | null } | null;
  isOwner: boolean;
}
export const getAccount = () => api.get<AccountInfo>('/account').then(r => r.data);
export const setAlertPhone = (phone: string | null) => api.patch<{ phone: string | null }>('/account/phone', { phone }).then(r => r.data);
export const inviteAccountMember = (data: { email?: string; phone?: string }) =>
  api.post<{ linked: boolean }>('/account/invites', data).then(r => r.data);
export const cancelAccountInvite = (id: string) => api.delete(`/account/invites/${id}`);
export const removeAccountMember = (id: string) => api.delete(`/account/members/${id}`);

// Scanned/digitized documents (phone scans, printer imports — auto-sorted mail)
export const getDocuments = (params?: { propertyId?: string; category?: DocumentCategory }) =>
  api.get<Document[]>('/scanned-documents', { params }).then(r => r.data);
export const analyzeScannedDocument = (fileData: string) =>
  api.post<{
    classified: DocumentClassification;
    match: DocumentMatch;
    properties: { id: string; address: string; nickname?: string }[];
  }>('/scanned-documents/analyze', { fileData }).then(r => r.data);
export const confirmScannedDocument = (data: {
  fileData: string; filename?: string; propertyId?: string | null;
  category: DocumentCategory; title: string; pageCount: number; notes?: string;
}) => api.post<Document>('/scanned-documents', data).then(r => r.data);
export const getDocumentUrl = (id: string) =>
  api.get<{ url: string }>(`/scanned-documents/${id}/url`).then(r => r.data.url);

// Reports (Rent Roll / T-12 xlsx exports, generated from real Sollux data)
export const RENT_ROLL_COLUMNS: { key: string; label: string }[] = [
  { key: 'bdba', label: 'BD/BA' },
  { key: 'status', label: 'Status' },
  { key: 'moveIn', label: 'Move-in Date' },
  { key: 'periodStart', label: 'Period Start' },
  { key: 'periodEnd', label: 'Period End' },
  { key: 'agreementType', label: 'Agreement Type' },
  { key: 'rent', label: 'Monthly Rent ($)' },
  { key: 'deposit', label: 'Deposits Held ($)' },
];

async function downloadReport(path: string, filename: string) {
  const res = await api.get(path, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
export const downloadRentRoll = (propertyId: string, propertyName: string, columns?: string[]) =>
  downloadReport(
    `/reports/rent-roll/${propertyId}${columns ? `?columns=${encodeURIComponent(columns.join(','))}` : ''}`,
    `Rent Roll - ${propertyName}.xlsx`,
  );
export const downloadT12 = (propertyId: string, propertyName: string, rows?: string[]) =>
  downloadReport(
    `/reports/t12/${propertyId}${rows ? `?rows=${encodeURIComponent(rows.join(','))}` : ''}`,
    `T12 - ${propertyName}.xlsx`,
  );
export const getT12Manifest = (propertyId: string) =>
  api.get<{ incomeRows: string[]; expenseRows: string[] }>(`/reports/t12/${propertyId}/manifest`).then(r => r.data);
export const deleteDocument = (id: string) =>
  api.delete(`/scanned-documents/${id}`);

// Index rates (e.g. WSJ Prime Rate history, for variable-rate loans)
export const getIndexRates = (indexName?: string) =>
  api.get<IndexRate[]>('/index-rates', { params: indexName ? { indexName } : undefined }).then(r => r.data);
export const createIndexRate = (data: { indexName?: string; rate: number; effectiveDate: string; notes?: string }) =>
  api.post<IndexRate>('/index-rates', data).then(r => r.data);
export const deleteIndexRate = (id: string) =>
  api.delete(`/index-rates/${id}`);

// Insurance
export const getInsurancePolicies = (params?: { propertyId?: string }) =>
  api.get<InsurancePolicy[]>('/insurance', { params }).then(r => r.data);
export const createInsurancePolicy = (data: Partial<InsurancePolicy>) =>
  api.post<InsurancePolicy>('/insurance', data).then(r => r.data);
export const updateInsurancePolicy = (id: string, data: Partial<InsurancePolicy>) =>
  api.patch<InsurancePolicy>(`/insurance/${id}`, data).then(r => r.data);
export const deleteInsurancePolicy = (id: string) =>
  api.delete(`/insurance/${id}`);

// Operating expenses
export type OpexPer = 'month' | 'year' | 'pctRent';
export type OpexSource = 'records' | 'manual' | 'estimate' | 'none';
export interface OpexManualLine { id: string; label: string; amount: number; per: OpexPer }
export interface OpexConfig {
  utilities?: Record<string, boolean>; lateFees?: 'separate' | 'exclude'; debtService?: boolean; categories?: Record<string, boolean>; capex?: boolean;
  taxes?: { source: OpexSource; manualAnnual?: number | null }; insurance?: { source: OpexSource; manualAnnual?: number | null }; manual?: OpexManualLine[];
}
export interface OpexEstimate { low: number; high: number; typical: number; basis: string; sources?: { title: string; url: string }[]; contacts?: string[]; at: string }
export interface OpexMoney { period: number; monthly: number; annual: number }
export interface OpexLine extends OpexMoney { key: string; group: string; label: string; source: string; note?: string }
export interface OpexStatement {
  months: number; income: OpexMoney; lines: OpexLine[]; totals: OpexMoney; noi: OpexMoney; ratio: number | null;
  perUnit: { annual: number } | null; perSqft: { annual: number } | null; belowNoi: OpexLine[]; cashFlow: OpexMoney | null;
  missing: ('taxes' | 'insurance')[]; notes: string[];
}
export interface OpexFacts {
  months: number; rentIncome: number; units: number; sqft: number | null;
  utilities: { id: string; name: string; category: string; total: number; fees: number; bills: number }[];
  categories: { category: string; total: number; count: number }[]; capex: number;
  tax: { annual: number | null; source: string | null }; insurance: { annual: number | null; source: string | null };
  debt: { paid: number; escrow: number; monthlyPI: number | null; lenders: string[]; fromBills: number };
  estimates?: { insurance?: OpexEstimate | null; tax?: OpexEstimate | null };
}
export interface OpexSuggestion { id: string; label: string; per: OpexPer; typical: number; hint: string }
export type OpexPeriod = 'last12' | 'ytd' | 'lastYear';
export interface OpexResponse {
  property: { id: string; name: string; state: string; county: string | null; apn: string | null };
  period: { key: OpexPeriod; label: string; start: string; end: string };
  configured: boolean; config: OpexConfig; facts: OpexFacts; suggestions: OpexSuggestion[]; statement: OpexStatement;
}
export const getOpex = (propertyId: string, period: OpexPeriod) => api.get<OpexResponse>(`/opex/${propertyId}`, { params: { period } }).then(r => r.data);
export const previewOpex = (propertyId: string, period: OpexPeriod, config: OpexConfig) => api.post<OpexResponse>(`/opex/${propertyId}/preview`, { period, config }).then(r => r.data);
export const saveOpexSetup = (propertyId: string, config: OpexConfig) => api.put(`/opex/${propertyId}/setup`, { config }).then(r => r.data);
export const estimateOpex = (propertyId: string, kind: 'insurance' | 'tax') => api.post<OpexEstimate>(`/opex/${propertyId}/estimate`, { kind }, { timeout: 180000 }).then(r => r.data);
export const getOpexPortfolio = (period: OpexPeriod) =>
  api.get<{ period: string; properties: { property: OpexResponse['property']; configured: boolean; statement: OpexStatement }[] }>('/opex', { params: { period } }).then(r => r.data);

// Insurance review and claims
export interface InsReviewFlag { code: string; severity: 'ALERT' | 'WARNING' | 'INFO'; text: string; policyId?: string }
export interface InsPolicyLine {
  id: string; carrier: string; policyNumber: string | null; policyType: string; annualPremium: number | null; effectiveDate: string | null; expirationDate: string | null;
  dwellingLimit: number | null; liabilityLimit: number | null; deductible: number | null; windHailDeductible: string | null; windHailDollars: number | null;
  replacementCostBasis: string | null; mortgageePayee: string | null; agentName: string | null; agentPhone: string | null; agentEmail: string | null;
  priorPremium: number | null; premiumChange: number | null;
}
export interface InsPropertyReview {
  propertyId: string; name: string; state: string | null; type: string; policies: InsPolicyLine[];
  coverage: { property: boolean; liability: boolean; flood: boolean; umbrella: boolean };
  annualPremium: number; replacementProxy: number | null; replacementSource: string | null; dwellingLimit: number | null; coverageRatio: number | null;
  premiumPerThousand: number | null; openClaims: number; flags: InsReviewFlag[];
}
export interface InsuranceReview {
  properties: InsPropertyReview[];
  totals: { annualPremium: number; policies: number; alerts: number; warnings: number; renewalsSoon: number };
  renewals: { propertyId: string; name: string; policyId: string; carrier: string; policyType: string; expirationDate: string; days: number; annualPremium: number | null; premiumChange: number | null }[];
}
export interface InsuranceClaim {
  id: string; propertyId: string; policyId?: string | null; claimNumber?: string | null; dateOfLoss?: string | null; reportedOn?: string | null;
  cause: string; description?: string | null; status: string; amountClaimed?: number | string | null; amountPaid?: number | string | null; deductibleApplied?: number | string | null;
  adjusterName?: string | null; adjusterPhone?: string | null; adjusterEmail?: string | null; nextStep?: string | null; nextStepDate?: string | null; notes?: string | null;
  property?: { id: string; address: string; nickname?: string | null };
}
export const getInsuranceReview = () => api.get<InsuranceReview>('/insurance/review').then(r => r.data);
export const getInsuranceClaims = (params?: { propertyId?: string }) => api.get<InsuranceClaim[]>('/insurance/claims', { params }).then(r => r.data);
export const saveInsuranceClaim = (data: Record<string, any>) => api.post<InsuranceClaim>('/insurance/claims', data).then(r => r.data);
export const updateInsuranceClaim = (id: string, data: Record<string, any>) => api.patch<InsuranceClaim>(`/insurance/claims/${id}`, data).then(r => r.data);
export const deleteInsuranceClaim = (id: string) => api.delete(`/insurance/claims/${id}`);

// Taxes
export const getTaxAssessments = (params?: { propertyId?: string }) =>
  api.get<TaxAssessment[]>('/taxes', { params }).then(r => r.data);
export const createTaxAssessment = (data: Partial<TaxAssessment>) =>
  api.post<TaxAssessment>('/taxes', data).then(r => r.data);
export const updateTaxAssessment = (id: string, data: Partial<TaxAssessment>) =>
  api.patch<TaxAssessment>(`/taxes/${id}`, data).then(r => r.data);
export const deleteTaxAssessment = (id: string) =>
  api.delete(`/taxes/${id}`);
export type FilePayload = { name: string; data: string };
export interface DocMatch { confidence: 'high' | 'medium' | 'low' | 'none'; propertyId: string | null; propertyName: string | null }
export const readTaxBill = (files: FilePayload[]) =>
  api.post<{ fields: Record<string, any>; match: DocMatch | null }>('/taxes/read', { files }).then(r => r.data);
export const saveTaxAssessment = (data: Record<string, any>) =>
  api.post<TaxAssessment>('/taxes', data).then(r => r.data);
export const getTaxDefaults = (params?: { propertyId?: string }) =>
  api.get<TaxDefault[]>('/taxes/defaults', { params }).then(r => r.data);
export const saveTaxDefault = (data: Record<string, any>) =>
  api.post<TaxDefault>('/taxes/defaults', data).then(r => r.data);
export const updateTaxDefault = (id: string, data: Record<string, any>) =>
  api.patch<TaxDefault>(`/taxes/defaults/${id}`, data).then(r => r.data);
export const deleteTaxDefault = (id: string) => api.delete(`/taxes/defaults/${id}`);
export interface TaxLookupStatus { status: 'queued' | 'running' | 'done' | 'failed'; at: string; note?: string | null; progress?: string | null; years?: number; defaults?: number }
export const startTaxLookup = (propertyId: string) => api.post('/taxes/lookup', { propertyId }).then(r => r.data);
export const getTaxLookupStatus = () => api.get<Record<string, TaxLookupStatus | null>>('/taxes/lookup-status').then(r => r.data);
export const getTaxRules = (state: string, taxYear: string) =>
  api.get<{ calendar: TaxCalendarInfo | null; timeline: TaxTimeline | null }>('/taxes/rules', { params: { state, taxYear } }).then(r => r.data);
export const taxBillUrl = (id: string) =>
  api.get<{ url: string }>(`/taxes/${id}/document`).then(r => r.data.url);

// Income tax: returns, forms received, W-9s, payments to tax agencies
export interface TaxDoc {
  id: string; taxYear: number; jurisdiction: string; formType: string; direction: 'RECEIVED' | 'FILED' | 'ISSUED'; status: string;
  issuerName?: string | null; recipientName?: string | null; businessName?: string | null; entityType?: string | null; tinLast4?: string | null;
  address?: string | null; propertyId?: string | null; loanId?: string | null; amount?: number | string | null; federalWithheld?: number | string | null;
  stateWithheld?: number | string | null; refundOrDue?: number | string | null; boxes?: Record<string, number | string> | null;
  filedDate?: string | null; dueDate?: string | null; documents?: { key: string; name: string }[] | null; notes?: string | null;
  property?: { id: string; address: string; nickname?: string | null } | null;
}
export interface TaxPay {
  id: string; taxYear: number; jurisdiction: string; kind: 'ESTIMATED' | 'BALANCE_DUE' | 'EXTENSION' | 'REFUND'; period?: string | null;
  dueDate?: string | null; paidDate?: string | null; amount: number | string; confirmation?: string | null; method?: string | null; notes?: string | null;
}
export interface TaxChecklist {
  year: number; statesWithIncomeTax: string[];
  forms: { formType: string; label: string; loanId: string; propertyId: string | null; documentId: string | null; done: boolean }[];
  returns: { jurisdiction: string; label: string; dueDate: string; documentId: string | null; filedDate: string | null; refundOrDue: number | string | null; done: boolean }[];
  estimatedPayments: { jurisdiction: string; period: string; dueDate: string; paid: number; paymentIds: string[] }[];
}
export interface ContractorRow {
  vendor: string; total: number; payments: number; categories: string[]; propertyCount: number; needs1099: boolean; corporation: boolean;
  w9: { id: string; entityType?: string | null; tinLast4?: string | null; taxYear: number } | null; issued1099: { id: string; amount?: number | string | null } | null;
}
export const getTaxDocs = (year?: number) =>
  api.get<{ documents: TaxDoc[]; payments: TaxPay[]; years: number[] }>('/tax-documents', { params: year ? { year } : {} }).then(r => r.data);
export const getTaxChecklist = (year: number) => api.get<TaxChecklist>('/tax-documents/checklist', { params: { year } }).then(r => r.data);
export const getContractors1099 = (year: number) =>
  api.get<{ year: number; threshold: number; contractors: ContractorRow[]; w9sOnFile: number }>('/tax-documents/contractors', { params: { year } }).then(r => r.data);
export const readTaxForm = (files: FilePayload[]) =>
  api.post<{ fields: Record<string, any>; match: DocMatch | null }>('/tax-documents/read', { files }).then(r => r.data);
export const createTaxDoc = (data: Record<string, any>) => api.post<TaxDoc>('/tax-documents', data).then(r => r.data);
export const updateTaxDoc = (id: string, data: Record<string, any>) => api.patch<TaxDoc>(`/tax-documents/${id}`, data).then(r => r.data);
export const deleteTaxDoc = (id: string) => api.delete(`/tax-documents/${id}`);
export const taxDocUrl = (id: string, n = 0) => api.get<{ url: string }>(`/tax-documents/${id}/documents/${n}`).then(r => r.data.url);
export const createTaxPayment = (data: Record<string, any>) => api.post<TaxPay>('/tax-documents/payments', data).then(r => r.data);
export const deleteTaxPayment = (id: string) => api.delete(`/tax-documents/payments/${id}`);

// Personal finance: credit cards
export interface CardPosition {
  balance: number; balanceSource: 'ENTERED' | 'STATEMENT' | 'NONE'; limit: number | null; available: number | null; utilization: number | null;
  apr: number | null; introActive: boolean; promoEndsInDays: number | null; monthlyInterest: number;
  statementStatus: 'PAID_IN_FULL' | 'MINIMUM_MET' | 'DUE' | 'PAST_DUE' | 'NO_BALANCE' | null; statementRemaining: number; minimumRemaining: number; minimumPayment: number;
  paidSinceClose: number; latestStatementId: string | null; latestClosingDate: string | null; nextDueDate: string | null; nextClosingDate: string | null;
  nextAnnualFee: string | null; rewardsBalance: number | null; rewardsValue: number | null; interestYtd: number; feesYtd: number; purchasesYtd: number;
}
export interface CreditCardT {
  id: string; name: string; issuer?: string | null; network?: string | null; last4?: string | null; cardholderName?: string | null; isBusiness: boolean;
  propertyId?: string | null; bankAccountId?: string | null; status: 'ACTIVE' | 'FROZEN' | 'CLOSED'; openedDate?: string | null; closedDate?: string | null;
  expiration?: string | null; creditLimit?: number | string | null; cashAdvanceLimit?: number | string | null; currentBalance?: number | string | null; balanceAsOf?: string | null;
  statementClosingDay?: number | null; paymentDueDay?: number | null; purchaseApr?: number | string | null; cashAdvanceApr?: number | string | null;
  balanceTransferApr?: number | string | null; penaltyApr?: number | string | null; introApr?: number | string | null; introAprType?: string | null; introAprEndDate?: string | null;
  annualFee?: number | string | null; annualFeeMonth?: number | null; foreignTransactionFee?: number | string | null; lateFee?: number | string | null;
  balanceTransferFee?: number | string | null; cashAdvanceFee?: number | string | null; rewardsProgram?: string | null; rewardsType?: string | null;
  rewardsBalance?: number | string | null; rewardsCentsPerPoint?: number | string | null; rewardsEarnRates?: string | null;
  autopay: string; autopayAmount?: number | string | null; autopayFromBankAccountId?: string | null; autopayFromName?: string | null;
  authorizedUsers?: { name: string; last4?: string | null }[] | null; loginUrl?: string | null; phone?: string | null; notes?: string | null;
  position: CardPosition; statementCount?: number;
  statements?: CardStatementT[]; payments?: CardPaymentT[]; spending?: { byCategory: Record<string, number>; byMonth: Record<string, number> };
}
export interface CardStatementT {
  id: string; periodStart?: string | null; closingDate: string; dueDate?: string | null; previousBalance?: number | string | null; paymentsCredits?: number | string | null;
  purchases?: number | string | null; balanceTransfers?: number | string | null; cashAdvances?: number | string | null; feesCharged?: number | string | null;
  interestCharged?: number | string | null; newBalance: number | string; minimumPayment?: number | string | null; creditLimit?: number | string | null;
  availableCredit?: number | string | null; purchaseApr?: number | string | null; rewardsEarned?: number | string | null; rewardsBalance?: number | string | null;
  minPayoffMonths?: number | null; minPayoffTotal?: number | string | null; transactionCount?: number; hasDocument?: boolean;
}
export interface CardPaymentT { id: string; date: string; amount: number | string; fromBankAccountId?: string | null; fromBankAccountName?: string | null; confirmation?: string | null; method?: string | null; notes?: string | null; statementId?: string | null }
export interface CardTxnT { id: string; date: string; postDate?: string | null; description: string; merchant?: string | null; amount: number | string; kind: string; category?: string | null; cardholder?: string | null; isBusiness: boolean; propertyId?: string | null; expenseId?: string | null; notes?: string | null; statementId?: string | null }
export interface CardsSummary { cards: number; debt: number; limits: number; available: number; utilization: number | null; monthlyInterest: number; minimumsDue30d: number; pastDue: number; promosEnding60d: number; annualFees: number; rewardsValue: number; interestYtd: number }
export const getCreditCards = () =>
  api.get<{ cards: CreditCardT[]; summary: CardsSummary; paymentSourceCards: { id: string; name: string; last4?: string | null; bank?: string | null; cardNetwork?: string | null; cardExpiry?: string | null }[] }>('/credit-cards').then(r => r.data);
export const getCreditCard = (id: string) => api.get<CreditCardT>(`/credit-cards/${id}`).then(r => r.data);
export const createCreditCard = (data: Record<string, any>) => api.post<CreditCardT>('/credit-cards', data).then(r => r.data);
export const createCardFromBankAccount = (bankAccountId: string) => api.post<CreditCardT>(`/credit-cards/from-bank-account/${bankAccountId}`).then(r => r.data);
export const updateCreditCard = (id: string, data: Record<string, any>) => api.patch<CreditCardT>(`/credit-cards/${id}`, data).then(r => r.data);
export const deleteCreditCard = (id: string) => api.delete(`/credit-cards/${id}`);
export const readCardStatement = (files: FilePayload[]) =>
  api.post<{ fields: Record<string, any>; cardId: string | null; cardName: string | null }>('/credit-cards/read-statement', { files }).then(r => r.data);
export const saveCardStatement = (cardId: string, body: { statement: Record<string, any>; transactions?: Record<string, any>[]; terms?: Record<string, any>; files?: FilePayload[] }) =>
  api.post<{ statement: CardStatementT; transactionsAdded: number }>(`/credit-cards/${cardId}/statements`, body).then(r => r.data);
export const deleteCardStatement = (sid: string) => api.delete(`/credit-cards/statements/${sid}`);
export const cardStatementUrl = (sid: string, n = 0) => api.get<{ url: string }>(`/credit-cards/statements/${sid}/document/${n}`).then(r => r.data.url);
export const getCardTransactions = (cardId: string, params: Record<string, string | undefined> = {}) =>
  api.get<CardTxnT[]>(`/credit-cards/${cardId}/transactions`, { params }).then(r => r.data);
export const createCardTransaction = (cardId: string, data: Record<string, any>) => api.post<CardTxnT>(`/credit-cards/${cardId}/transactions`, data).then(r => r.data);
export const updateCardTransaction = (tid: string, data: Record<string, any>) => api.patch<CardTxnT>(`/credit-cards/transactions/${tid}`, data).then(r => r.data);
export const deleteCardTransaction = (tid: string) => api.delete(`/credit-cards/transactions/${tid}`);
export const cardTransactionToExpense = (tid: string, data: { propertyId: string; category: string }) => api.post(`/credit-cards/transactions/${tid}/expense`, data).then(r => r.data);
export const createCardPayment = (cardId: string, data: Record<string, any>) => api.post<CardPaymentT>(`/credit-cards/${cardId}/payments`, data).then(r => r.data);
export const deleteCardPayment = (pid: string) => api.delete(`/credit-cards/payments/${pid}`);

// Compliance: citations, orders to comply, permits, inspections
export const getComplianceItems = (params?: { propertyId?: string; status?: string }) =>
  api.get<ComplianceItem[]>('/compliance', { params }).then(r => r.data);
export const readCitation = (files: FilePayload[]) =>
  api.post<{ fields: Record<string, any>; match: DocMatch | null }>('/compliance/read', { files }).then(r => r.data);
export const createComplianceItem = (data: Record<string, any>) =>
  api.post<ComplianceItem>('/compliance', data).then(r => r.data);
export const updateComplianceItem = (id: string, data: Record<string, any>) =>
  api.patch<ComplianceItem>(`/compliance/${id}`, data).then(r => r.data);
export const deleteComplianceItem = (id: string) => api.delete(`/compliance/${id}`);
export const complianceDocumentUrl = (id: string, n: number) =>
  api.get<{ url: string; name: string }>(`/compliance/${id}/documents/${n}`).then(r => r.data.url);
export const payComplianceItem = (id: string, data: { amount: number; date: string; vendor?: string | null; description?: string | null; category?: string }) =>
  api.post(`/compliance/${id}/payments`, data).then(r => r.data);

// Development projects and transfers abroad
export const getProjects = () => api.get<DevelopmentProject[]>('/projects').then(r => r.data);
export const getProject = (id: string) => api.get<DevelopmentProject>(`/projects/${id}`).then(r => r.data);
export const createProject = (data: Record<string, any>) => api.post<DevelopmentProject>('/projects', data).then(r => r.data);
export const updateProject = (id: string, data: Record<string, any>) => api.patch<DevelopmentProject>(`/projects/${id}`, data).then(r => r.data);
export const deleteProject = (id: string) => api.delete(`/projects/${id}`);
export const readTransferReceipt = (files: FilePayload[]) =>
  api.post<{ fields: Record<string, any> }>('/projects/read-receipt', { files }).then(r => r.data);
export const createTransfer = (projectId: string, data: Record<string, any>) =>
  api.post<ProjectTransfer>(`/projects/${projectId}/transfers`, data).then(r => r.data);
export const updateTransfer = (id: string, data: Record<string, any>) =>
  api.patch<ProjectTransfer>(`/projects/transfers/${id}`, data).then(r => r.data);
export const deleteTransfer = (id: string) => api.delete(`/projects/transfers/${id}`);
export const transferReceiptUrl = (id: string) =>
  api.get<{ url: string }>(`/projects/transfers/${id}/document`).then(r => r.data.url);

// Improvements
export const getImprovements = (params?: { propertyId?: string }) =>
  api.get<Improvement[]>('/improvements', { params }).then(r => r.data);
export const createImprovement = (data: Partial<Improvement>) =>
  api.post<Improvement>('/improvements', data).then(r => r.data);
export const updateImprovement = (id: string, data: Partial<Improvement>) =>
  api.patch<Improvement>(`/improvements/${id}`, data).then(r => r.data);
export const deleteImprovement = (id: string) =>
  api.delete(`/improvements/${id}`);

// Legal
export const getLegalMatters = (params?: { propertyId?: string; status?: string; matterType?: string; open?: string }) =>
  api.get<LegalMatter[]>('/legal', { params }).then(r => r.data);
export const createLegalMatter = (data: Partial<LegalMatter>) =>
  api.post<LegalMatter>('/legal', data).then(r => r.data);
export const updateLegalMatter = (id: string, data: Partial<LegalMatter>) =>
  api.patch<LegalMatter>(`/legal/${id}`, data).then(r => r.data);
export const deleteLegalMatter = (id: string) =>
  api.delete(`/legal/${id}`);
export const getLegalSummary = () =>
  api.get<LegalSummary>('/legal/summary').then(r => r.data);
// Timeline
export const addLegalEvent = (matterId: string, data: Partial<LegalEvent>) =>
  api.post<LegalEvent>(`/legal/${matterId}/events`, data).then(r => r.data);
export const deleteLegalEvent = (matterId: string, eventId: string) =>
  api.delete(`/legal/${matterId}/events/${eventId}`);
// Fees and payments
export const addLegalFee = (matterId: string, data: Partial<LegalFee>) =>
  api.post<LegalFee>(`/legal/${matterId}/fees`, data).then(r => r.data);
export const updateLegalFee = (matterId: string, feeId: string, data: Partial<LegalFee>) =>
  api.patch<LegalFee>(`/legal/${matterId}/fees/${feeId}`, data).then(r => r.data);
export const deleteLegalFee = (matterId: string, feeId: string) =>
  api.delete(`/legal/${matterId}/fees/${feeId}`);
// Documents
export const getLegalDocuments = (matterId: string) =>
  api.get<Document[]>(`/legal/${matterId}/documents`).then(r => r.data);
export const addLegalDocument = (matterId: string, data: { fileData: string; filename?: string; category: string; title?: string; notes?: string }) =>
  api.post<Document>(`/legal/${matterId}/documents`, data).then(r => r.data);
export const getLegalDocumentUrl = (matterId: string, docId: string) =>
  api.get<{ url: string }>(`/legal/${matterId}/documents/${docId}/url`).then(r => r.data);
export const deleteLegalDocument = (matterId: string, docId: string) =>
  api.delete(`/legal/${matterId}/documents/${docId}`);

// P&L
export const getPortfolioPnL = (params?: { start?: string; end?: string }) =>
  api.get<{ byProperty: PropertyPnL[]; totals: PropertyPnL }>('/pnl/portfolio', { params }).then(r => r.data);
export const getPropertyPnL = (id: string, params?: { start?: string; end?: string }) =>
  api.get<PropertyPnL>(`/pnl/property/${id}`, { params }).then(r => r.data);
export const getMonthlyPnL = (params?: { year?: number; propertyId?: string }) =>
  api.get<MonthlyPnL[]>('/pnl/monthly', { params }).then(r => r.data);

// Cash flow: rent received against loans, and against loans + utilities
export interface CashflowMonth {
  month: string; rent: number; rentExpected: number; loans: number; loansScheduled: boolean; utilities: number;
  netAfterLoans: number; netAfterAll: number;
  detail: {
    rent: { tenant: string; unit: string; amount: number; paidDate: string }[];
    loans: { lender: string; amount: number; scheduled: boolean; date: string | null }[];
    utilities: { provider: string; amount: number; period: string | null }[];
  };
}
export interface CashflowTotals { rent: number; rentExpected: number; loans: number; utilities: number; netAfterLoans: number; netAfterAll: number }
export interface CashflowProperty { propertyId: string; propertyName: string; months: CashflowMonth[]; totals: CashflowTotals }
export interface CashflowReport {
  year: number; months: string[]; byProperty: CashflowProperty[];
  totals: CashflowTotals & { byMonth: { month: string; rent: number; loans: number; utilities: number; netAfterLoans: number; netAfterAll: number }[] };
}
export const getCashflow = (params?: { year?: number; propertyId?: string }) =>
  api.get<CashflowReport>('/cashflow', { params }).then(r => r.data);

// Utility accounts
export const getUtilities = (propertyId?: string) =>
  api.get<UtilityAccount[]>('/utilities', { params: { propertyId } }).then(r => r.data);
export const getUtility = (id: string) =>
  api.get<UtilityAccount & { statements: any[]; payments: any[] }>(`/utilities/${id}`).then(r => r.data);
export const createUtility = (data: Partial<UtilityAccount> & { username?: string; password?: string; insuranceType?: string; loanType?: string }) =>
  api.post<UtilityAccount>('/utilities', data).then(r => r.data);
export const updateUtility = (id: string, data: any) =>
  api.patch<UtilityAccount>(`/utilities/${id}`, data).then(r => r.data);
export const deleteUtility = (id: string) =>
  api.delete(`/utilities/${id}`);
export const syncUtility = (id: string) =>
  api.post<{ jobId: string }>(`/utilities/${id}/sync`).then(r => r.data);
/** Stop a fetch that is queued or running for this account. */
export const cancelFetch = (id: string) => api.post<{ cancelled: number }>(`/utilities/${id}/cancel-fetch`).then(r => r.data);
// The verification code a portal sent, for the portal agent waiting on it.
export const submitPortalCode = (id: string, code: string) => api.post(`/utilities/${id}/portal-code`, { code });
export const revealUtilityAccountNumber = (id: string) =>
  api.get<{ accountNumber: string | null }>(`/utilities/${id}/account-number`).then(r => r.data);
export const getUtilityUsername = (id: string) =>
  api.get<{ username: string | null }>(`/utilities/${id}/username`).then(r => r.data);
export const getUtilityPassword = (id: string) =>
  api.get<{ password: string | null }>(`/utilities/${id}/password`).then(r => r.data);

// Statements
export const getStatements = (params: { utilityAccountId?: string; propertyId?: string }) =>
  api.get<Statement[]>('/statements', { params }).then(r => r.data);
export const getStatementDownloadUrl = (id: string) =>
  api.get<{ url: string }>(`/statements/${id}/download`).then(r => r.data);
export const deleteStatement = (id: string) =>
  api.delete<{ success: boolean }>(`/statements/${id}`).then(r => r.data);
export const patchStatement = (id: string, data: {
  amountPaid?: number | null; statementDate?: string; dueDate?: string | null;
  amountDue?: number | null; chargesExcludingFees?: number | null;
  penaltiesFees?: number | null; pastDueCarried?: number | null; notes?: string | null;
  paidOverride?: 'UNPAID' | 'PAID' | null;
}) => api.patch<Statement>(`/statements/${id}`, data).then(r => r.data);
/** The owner says this bill is not paid: undoes Mark paid and pins it open. */
export const markStatementUnpaid = (id: string) =>
  api.post<Statement & { removedMarkPaid: number }>(`/statements/${id}/unpaid`).then(r => r.data);
export const createStatement = (data: {
  utilityAccountId: string; statementDate: string; dueDate?: string | null;
  amountDue?: number | null; amountPaid?: number | null; chargesExcludingFees?: number | null;
  penaltiesFees?: number | null; pastDueCarried?: number | null; notes?: string | null;
}) => api.post<Statement>('/statements', data).then(r => r.data);
export const getStatementsSummary = (params?: { propertyId?: string; utilityAccountId?: string }) =>
  api.get<StatementSummaryRow[]>('/statements/summary', { params }).then(r => r.data);

// Utility payments
export const getPayments = (params: { utilityAccountId?: string; propertyId?: string }) =>
  api.get<Payment[]>('/payments', { params }).then(r => r.data);
export const updatePayment = (id: string, data: any) =>
  api.patch<Payment>(`/payments/${id}`, data).then(r => r.data);
export const deletePayment = (id: string) =>
  api.delete(`/payments/${id}`);
export const createPayment = (data: any) =>
  api.post<Payment>('/payments', data).then(r => r.data);
// One real payment covering several bills: one row per bill, sharing a splitGroupId.
export const createSplitPayment = (data: any & { allocations: { statementId: string; amount: number }[] }) =>
  api.post<Payment[]>('/payments/split', data).then(r => r.data);

// Insights
// Run the nightly bookkeeper now; findings land as insights.
export const runBookkeeper = () =>
  api.post<{ raised: number; refreshed: number; cleared: number; count: number }>('/insights/bookkeeper/run').then(r => r.data);
export const getInsights = (params?: { propertyId?: string; severity?: string; type?: string; unread?: boolean }) =>
  api.get<AIInsight[]>('/insights', { params }).then(r => r.data);
export const markInsightRead = (id: string) =>
  api.patch<AIInsight>(`/insights/${id}/read`).then(r => r.data);
export const dismissInsight = (id: string) =>
  api.patch<AIInsight>(`/insights/${id}/dismiss`).then(r => r.data);
export const markAllInsightsRead = () =>
  api.patch<{ count: number }>('/insights/read-all').then(r => r.data);
export const dismissAllInfoInsights = () =>
  api.patch<{ count: number }>('/insights/dismiss-info').then(r => r.data);

// Notifications
export const getNotificationPreferences = () =>
  api.get('/notifications/preferences').then(r => r.data);
export const updateNotificationPreferences = (data: any) =>
  api.patch('/notifications/preferences', data).then(r => r.data);

// Gmail
export const getGmailConnectUrl = () =>
  api.post<{ url: string }>('/gmail/connect').then(r => r.data);
export interface GmailMailbox { id: string; email: string; label?: string | null; lastScanAt?: string | null; lastScanError?: string | null; backfillFrom?: string | null; backlog?: number | null }
export const getGmailStatus = () =>
  api.get<{ connected: boolean; accounts: GmailMailbox[] }>('/gmail/status').then(r => r.data);
export interface InboxActivity {
  messages: { id: string; mailbox: string; fromAddress: string | null; subject: string | null; receivedAt: string | null; outcome: string; detail: string | null; utilityAccountId: string | null; importJobId: string | null; createdAt: string }[];
  lastJob: { id: string; source?: string; label?: string | null; finishedAt: string | null; autoImported: number; needsReview: number; errorLog: string | null } | null;
  last30Days: Record<string, number>;
  // Accounts billed monthly / every two months with no bill for longer than that.
  quietAccounts?: { utilityAccountId: string; propertyId: string; provider: string; property: string; lastBill: string | null; days: number }[];
}
export const getInboxActivity = (opts: { skipped?: boolean } = {}) =>
  api.get<InboxActivity>('/gmail/inbox', { params: opts.skipped ? { skipped: 1 } : {} }).then(r => r.data);
export const syncInbox = (tokenId?: string, backfillDays?: number) =>
  api.post<{ jobId: string; accounts: number }>('/gmail/sync', { tokenId, backfillDays }).then(r => r.data);
// With s3Keys, only those cards leave the review list; without, the whole list is done.
export const markInboxReviewed = (jobId: string, s3Keys?: string[]) => api.post(`/gmail/inbox/reviewed/${jobId}`, s3Keys ? { s3Keys } : {});
// Statements that are one bill filed twice (a summary email beside the PDF statement).
export interface DuplicateStatementPair {
  keepId: string; dropId: string; utilityAccountId: string; propertyId: string; provider: string; property: string;
  amount: number | null; dueDate: string | null;
  keep: { statementDate: string; hasPeriod: boolean }; drop: { statementDate: string; hasPeriod: boolean };
}
export const getDuplicateStatements = () => api.get<DuplicateStatementPair[]>('/statements/duplicates').then(r => r.data);
export const mergeDuplicateStatements = (body: { all?: boolean; pairs?: { keepId: string; dropId: string }[] }) =>
  api.post<{ merged: number }>('/statements/duplicates/merge', body).then(r => r.data);

// Google Drive
export const getDriveConnectUrl = () =>
  api.post<{ url: string }>('/drive/connect').then(r => r.data);
export const getDriveStatus = () =>
  api.get<{ connected: boolean; accounts: { id: string; email: string }[] }>('/drive/status').then(r => r.data);
export const getDriveAccessToken = (tokenId: string) =>
  api.get<{ accessToken: string }>('/drive/access-token', { params: { tokenId } }).then(r => r.data);
export const startDriveImport = (
  tokenId: string,
  // method defaults to free regex parsing server-side; 'ai' bills per PDF.
  selection: { folderId?: string; fileIds?: string[]; folderName?: string; method?: 'ai' | 'regex' }
) =>
  api.post<{ jobId: string }>('/drive/import', { tokenId, ...selection }).then(r => r.data);
export const getDriveImportJob = (jobId: string) =>
  api.get(`/drive/jobs/${jobId}`).then(r => r.data);

// Payment plans
export const getPaymentPlan = (utilityAccountId: string) =>
  api.get(`/utilities/${utilityAccountId}/payment-plan`).then(r => r.data).catch(() => null);
export const createPaymentPlan = (utilityAccountId: string, data: {
  totalAmount: number; monthlyAmount: number; installmentFee?: number | null; downPayment?: number | null; startDate: string; description?: string; installmentsMade?: number;
}) => api.post(`/utilities/${utilityAccountId}/payment-plan`, data).then(r => r.data);
export const updatePaymentPlan = (utilityAccountId: string, data: {
  applyPayment?: number; remainingBalance?: number; monthlyAmount?: number; installmentFee?: number | null;
  status?: string; description?: string;
}) => api.patch(`/utilities/${utilityAccountId}/payment-plan`, data).then(r => r.data);
export const deletePaymentPlan = (utilityAccountId: string) =>
  api.delete(`/utilities/${utilityAccountId}/payment-plan`);

// The individual loans under one serviced account. Each call returns the
// parent loan with its components and refreshed totals.
export type LoanComponentInput = Partial<Omit<LoanComponent, 'id' | 'loanId' | 'sortOrder'>> & { label: string };
export const addLoanComponent = (loanId: string, data: LoanComponentInput) =>
  api.post<Loan>(`/loans/${loanId}/components`, data).then(r => r.data);
export const updateLoanComponent = (loanId: string, componentId: string, data: Partial<LoanComponentInput>) =>
  api.patch<Loan>(`/loans/${loanId}/components/${componentId}`, data).then(r => r.data);
export const deleteLoanComponent = (loanId: string, componentId: string) =>
  api.delete<Loan>(`/loans/${loanId}/components/${componentId}`).then(r => r.data);

// Loan linked to utility account
export const upsertUtilityLoan = (utilityAccountId: string, data: Record<string, unknown>) =>
  api.put(`/utilities/${utilityAccountId}/loan`, data).then(r => r.data);
export const deleteUtilityLoan = (utilityAccountId: string) =>
  api.delete(`/utilities/${utilityAccountId}/loan`);

// Bank Accounts
export const getBankAccounts = () =>
  api.get<BankAccount[]>('/bank-accounts').then(r => r.data);
export const createBankAccount = (data: Partial<BankAccount>) =>
  api.post<BankAccount>('/bank-accounts', data).then(r => r.data);
export const updateBankAccount = (id: string, data: Partial<BankAccount>) =>
  api.patch<BankAccount>(`/bank-accounts/${id}`, data).then(r => r.data);
export const deleteBankAccount = (id: string) =>
  api.delete(`/bank-accounts/${id}`);
export const recordBankBalance = (id: string, data: { balance: number; creditLimit?: number; asOfDate?: string; notes?: string }) =>
  api.post(`/bank-accounts/${id}/balance`, data).then(r => r.data);

// Pending outflows and the pay planner
export const addPendingOutflow = (bankAccountId: string, data: { amount: number; description: string; kind?: PendingOutflowKind; expectedDate?: string | null; loanId?: string | null; notes?: string | null }) =>
  api.post<PendingOutflow>(`/bank-accounts/${bankAccountId}/pending`, data).then(r => r.data);
export const updatePendingOutflow = (id: string, data: Partial<Pick<PendingOutflow, 'amount' | 'description' | 'kind' | 'expectedDate' | 'cleared' | 'notes' | 'bankAccountId'>>) =>
  api.patch<PendingOutflow>(`/bank-accounts/pending/${id}`, data).then(r => r.data);
export const deletePendingOutflow = (id: string) =>
  api.delete(`/bank-accounts/pending/${id}`);
export const getPayPlan = (params?: { days?: number; cushion?: number; utilities?: boolean }) =>
  api.get<PayPlan>('/pay-plan', { params: { days: params?.days, cushion: params?.cushion, utilities: params?.utilities === false ? '0' : undefined } }).then(r => r.data);

// Other Income
export const createOtherIncome = (data: Partial<OtherIncome>) =>
  api.post<OtherIncome>('/other-income', data).then(r => r.data);
export const deleteOtherIncome = (id: string) =>
  api.delete(`/other-income/${id}`);

// Budget
export const getBudgetMonthly = (year: number, month: number, includePersonal = false) =>
  api.get<BudgetSummary>('/budget/monthly', { params: { year, month, includePersonal } }).then(r => r.data);
export const getBudgetDelinquency = () =>
  api.get<{ tenants: DelinquencyTenant[]; totalArrears: number; totalExpectedCollection: number }>('/budget/delinquency').then(r => r.data);
export const getBudgetForecast = (months = 6) =>
  api.get<BudgetForecast>('/budget/forecast', { params: { months } }).then(r => r.data);

// AI portfolio query
// Ask Sollux with tools: answers from live data; proposed payments run only on Confirm.
export interface AgentAction { tool: string; input: Record<string, unknown>; summary: string }
export interface SolluxAttachment { key: string; name: string }
export const askSollux = (messages: { role: 'user' | 'assistant'; content: string; attachments?: SolluxAttachment[] }[], today: string) =>
  api.post<{ answer: string; actions: AgentAction[] }>('/ai/agent', { messages, today }, { timeout: 360000 }).then(r => r.data);
export const attachToSollux = (files: { name: string; data: string }[]) =>
  api.post<{ attachments: SolluxAttachment[] }>('/ai/agent/attachments', { files }, { timeout: 180000 }).then(r => r.data.attachments);
export const confirmSolluxAction = (a: AgentAction) =>
  api.post<{ result: string }>('/ai/agent/confirm', { tool: a.tool, input: a.input }).then(r => r.data);

// Plaid bank sync
export const createPlaidLinkToken = () =>
  api.post<{ link_token: string }>('/plaid/link-token').then(r => r.data);
export const exchangePlaidToken = (public_token: string, metadata: any) =>
  api.post('/plaid/exchange-token', { public_token, metadata }).then(r => r.data);
export const getPlaidItems = () =>
  api.get<PlaidItem[]>('/plaid/items').then(r => r.data);
export const deletePlaidItem = (id: string) =>
  api.delete(`/plaid/items/${id}`);
export const syncPlaidBalances = () =>
  api.post<{ synced: number; failed: number }>('/plaid/sync').then(r => r.data);

// Incoming P2P transactions (rent via Zelle/Venmo/PayPal/Cash App)
export const getIncomingTransactions = (status?: IncomingTransactionStatus) =>
  api.get<IncomingTransaction[]>('/transactions', { params: status ? { status } : undefined }).then(r => r.data);
export const syncIncomingTransactions = () =>
  api.post<{ itemsSynced: number; added: number; errors: string[] }>('/transactions/sync').then(r => r.data);
export const matchIncomingTransaction = (id: string, leaseId: string | null) =>
  api.patch<IncomingTransaction>(`/transactions/${id}`, { leaseId }).then(r => r.data);
export const applyIncomingTransaction = (id: string) =>
  api.post<IncomingTransaction>(`/transactions/${id}/apply`).then(r => r.data);
export const ignoreIncomingTransaction = (id: string) =>
  api.post<IncomingTransaction>(`/transactions/${id}/ignore`).then(r => r.data);

// Outgoing transactions (hardware-store expenses, utility bill payments)
export const getOutgoingTransactions = (status?: IncomingTransactionStatus) =>
  api.get<OutgoingTransaction[]>('/expense-transactions', { params: status ? { status } : undefined }).then(r => r.data);
export const syncOutgoingTransactions = () =>
  api.post<{ itemsSynced: number; added: number; errors: string[] }>('/expense-transactions/sync').then(r => r.data);
export const matchOutgoingTransaction = (id: string, data: {
  propertyId?: string | null; category?: string | null; utilityAccountId?: string | null; statementId?: string | null; loanId?: string | null;
}) => api.patch<OutgoingTransaction>(`/expense-transactions/${id}`, data).then(r => r.data);
export const getLoanCandidates = (id: string) =>
  api.get<{ loanId: string; lender: string; expected: number; likely: boolean }[]>(`/expense-transactions/${id}/loan-candidates`).then(r => r.data);
export const getUtilityCandidates = (id: string) =>
  api.get<UtilityCandidate[]>(`/expense-transactions/${id}/utility-candidates`).then(r => r.data);
export const applyOutgoingTransaction = (id: string) =>
  api.post<OutgoingTransaction>(`/expense-transactions/${id}/apply`).then(r => r.data);
export const ignoreOutgoingTransaction = (id: string) =>
  api.post<OutgoingTransaction>(`/expense-transactions/${id}/ignore`).then(r => r.data);

export interface PlaidItem {
  id: string;
  institutionName: string;
  institutionId: string;
  isActive: boolean;
  lastSyncedAt: string | null;
  accounts: Array<{
    id: string;
    name: string;
    last4: string | null;
    ownerLabel: string | null;
    accountType: string;
    isActive: boolean;
    watchForRentPayments?: boolean;
    watchForExpenses?: boolean;
    plaidAccountId?: string | null;
    balances: Array<{
      balance: number;
      available: number | null;
      creditLimit: number | null;
      asOfDate: string;
      source: string | null;
    }>;
  }>;
}

// Turnover — tenancy history, vacancy gaps and lost rent, derived from leases.
export const getTurnover = (params?: { propertyId?: string }) =>
  api.get<TurnoverReport>('/turnover', { params }).then(r => r.data);

// ── Cost settings ────────────────────────────────────────
// What counts as operating cost. Stored on the account, not the browser, so
// the figures agree wherever they are computed.
export interface CostSettings {
  includePenaltiesInOperating: boolean;
  includePaymentPlanInOperating: boolean;
}
export const getCostSettings = () =>
  api.get<CostSettings>('/settings').then(r => r.data);
export const updateCostSettings = (data: Partial<CostSettings>) =>
  api.patch<CostSettings>('/settings', data).then(r => r.data);

// ── Payment priorities ───────────────────────────────────
// What to pay first, and what lateness has cost. Separate from the utility
// endpoints deliberately: those report cost, these report exposure.
export interface AccountPriority {
  accountId: string;
  propertyId: string;
  propertyName: string;
  providerName: string;
  serviceLabel: string | null;
  category: string;
  balanceToCurrent: number;
  currentCharges: number;
  pastDue: number;
  paymentPlan: { monthlyAmount: number; installmentFee: number; remainingBalance: number; endDate: string | null; description: string | null } | null;
  onPlan: number;
  installmentBilled: boolean;
  totalAccountBalance: number | null;
  trueUp: { deferredThisBill: number; balance: number | null; date: string | null } | null;
  payThisMonth: number;
  dueDate: string | null;
  penaltyDate: string | null;
  penaltyDateIsEstimate: boolean;
  daysUntilPenalty: number | null;
  feeBehaviour: 'charges_every_time' | 'charges_sometimes' | 'never_charged' | 'unknown';
  billsWithFees: number;
  billsSeen: number;
  averageFee: number;
  totalFeesPaid: number;
  knownNextFee: number | null;
  feeSource: 'your_rule' | 'stated_on_bill' | 'history' | 'none';
  shutoffDate: string | null;
  daysUntilShutoff: number | null;
  typicalGraceDays: number | null;
  urgencyScore: number;
  reasons: string[];
}

export interface FeeSummary {
  totalFeesPaid: number;
  billsWithFees: number;
  byProvider: { providerName: string; propertyName: string; accountId: string; total: number; count: number }[];
  byMonth: { month: string; total: number }[];
}

export const getPaymentPriorities = (propertyId?: string) =>
  api.get<AccountPriority[]>('/priorities', { params: propertyId ? { propertyId } : {} }).then(r => r.data);
export const getFeeSummary = (months?: number) =>
  api.get<FeeSummary>('/priorities/fees', { params: months ? { months } : {} }).then(r => r.data);

// ── Charge analytics ─────────────────────────────────────
export interface ChargeLineSeries {
  label: string;
  isFee: boolean;
  months: { month: string; amount: number }[];
  total: number;
  average: number;
  latest: number | null;
  first: string | null;
  last: string | null;
  changePercent: number | null;
}
export interface ChargeAnalytics {
  accountId: string;
  providerName: string;
  monthsCovered: number;
  lines: ChargeLineSeries[];
  byMonth: { month: string; total: number; itemised: number }[];
  yearToDate: number;
  notable: string[];
}
export interface AgingReconciliation {
  reported: { current: number; days30: number; days60: number; days90plus: number } | null;
  reportedAsOf: string | null;
  derived: { current: number; days30: number; days60: number; days90plus: number };
  differences: { bucket: string; reported: number; derived: number; difference: number }[];
  findings: string[];
}
export const getChargeAnalytics = (accountId: string, months?: number) =>
  api.get<ChargeAnalytics>(`/analytics/charges/${accountId}`, { params: months ? { months } : {} }).then(r => r.data);
export const getAgingReconciliation = (accountId: string) =>
  api.get<AgingReconciliation>(`/analytics/aging/${accountId}`).then(r => r.data);

// Slim per-account billing history for the portfolio spend figures. The
// properties list carries one statement per account, which cannot produce an
// average.
export const getSpendData = () =>
  api.get<any[]>('/properties/spend-data').then(r => r.data);

// ── ClickUp ─────────────────────────────────────────────────────────────────
export interface ClickUpStatus {
  connected: boolean;
  user?: string | null;
  team?: { id: string; name: string | null } | null;
  space?: { id: string; name: string | null } | null;
  folder?: { id: string; name: string | null } | null;
  syncBills?: boolean;
  webhook?: boolean;
}
export interface ClickUpTask {
  id: string;
  name: string;
  description?: string;
  status: { status: string; type: string; color?: string };
  priority: { id: string; priority: string } | null;
  due_date: string | null;
  date_created: string;
  date_updated: string;
  date_closed: string | null;
  url: string;
  tags: { name: string }[];
  assignees: { id: number; username: string; initials?: string; profilePicture?: string | null }[];
}
export interface ClickUpTaskGroup { propertyId: string; propertyName: string; listId: string; tasks: ClickUpTask[] }

export const getClickUpStatus = () => api.get<ClickUpStatus>('/clickup/status').then(r => r.data);
export const connectClickUp = (token: string) =>
  api.post<{ connected: boolean; user: string; teams: { id: string; name: string }[]; warning?: string }>('/clickup/connect', { token }).then(r => r.data);
export const disconnectClickUp = () => api.delete('/clickup/disconnect');
export const getClickUpTeams = () => api.get<{ teams: { id: string; name: string }[] }>('/clickup/teams').then(r => r.data.teams);
export const getClickUpSpaces = (teamId: string) => api.get<{ spaces: { id: string; name: string }[] }>('/clickup/spaces', { params: { teamId } }).then(r => r.data.spaces);
export const getClickUpFolders = (spaceId: string) => api.get<{ folders: { id: string; name: string }[] }>('/clickup/folders', { params: { spaceId } }).then(r => r.data.folders);
export const setClickUpTarget = (t: { teamId: string; teamName: string; spaceId: string; spaceName: string; folderId: string; folderName: string }) =>
  api.put('/clickup/target', t).then(r => r.data);
export const updateClickUpSettings = (s: { syncBills: boolean }) => api.patch('/clickup/settings', s).then(r => r.data);
export const getClickUpTasks = (opts: { propertyId?: string; includeClosed?: boolean } = {}) =>
  api.get<{ groups: ClickUpTaskGroup[] }>('/clickup/tasks', { params: opts }).then(r => r.data.groups);
export const createClickUpTask = (t: { propertyId: string; name: string; description?: string; dueDate?: string | null; priority?: 1 | 2 | 3 | 4 | null }) =>
  api.post<ClickUpTask>('/clickup/tasks', t).then(r => r.data);
export const closeClickUpTask = (id: string, listId: string) => api.post(`/clickup/tasks/${id}/close`, { listId }).then(r => r.data);
export const syncClickUpBills = () =>
  api.post<{ created: number; updated: number; closed: number; skipped: string[] }>('/clickup/sync-bills').then(r => r.data);


// ─── Tenant utility reimbursement ───────────────────────────────────────────
export interface ReimbursementRule { category: string; mode: 'PERCENT' | 'FULL' | 'FLAT_MONTHLY'; value: number; label?: string }
export interface ReimbursementConfig {
  id: string; leaseId: string; enabled: boolean; rulesJson: ReimbursementRule[]; accountIdsJson: string[] | null;
  creditBalance: number | string; notes: string | null;
  payableTo?: string | null; paymentInstructions?: string | null;
}
/** Payment terms set by hand on an invoice: no due date means none is printed. */
export interface ReimbursementTerms { dueDate?: string | null; payableTo?: string | null; paymentInstructions?: string | null }
export interface ReimbursementInvoiceSummary {
  id: string; periodStart: string; periodEnd: string; subtotal: number | string; creditApplied: number | string;
  total: number | string; paidAmount: number | string; paidAt: string | null; status: string; createdAt: string;
  _count: { lines: number };
}
export interface ReimbursementLine {
  id?: string; key?: string; kind: 'STATEMENT' | 'FLAT'; category: string; label: string; statementId: string | null;
  periodStart: string | null; periodEnd: string | null; baseAmount: number | string; sharePercent: number | null;
  amount: number | string; sortKey: string;
}
export interface ReimbursementDraft {
  from: string; to: string; lines: ReimbursementLine[]; subtotal: number; creditAvailable: number; creditApplied: number; total: number;
  alreadyBilled: { statementId: string; label: string; period: string; invoiceId: string }[];
}
export const getReimbursement = (leaseId: string) =>
  api.get<{ lease: any; config: ReimbursementConfig | null; invoices: ReimbursementInvoiceSummary[]; accounts: { id: string; providerName: string; serviceLabel: string | null; category: string; unitId: string | null }[] }>(`/reimbursements/lease/${leaseId}`).then(r => r.data);
export const saveReimbursement = (leaseId: string, body: { enabled: boolean; rules: ReimbursementRule[]; accountIds?: string[]; notes?: string | null }) =>
  api.put<ReimbursementConfig>(`/reimbursements/lease/${leaseId}`, body).then(r => r.data);
export const previewReimbursementInvoice = (leaseId: string, from: string, to: string, exclude: string[] = []) =>
  api.post<ReimbursementDraft>(`/reimbursements/lease/${leaseId}/preview`, { from, to, exclude }).then(r => r.data);
export const createReimbursementInvoice = (leaseId: string, from: string, to: string, exclude: string[] = [], terms?: ReimbursementTerms) =>
  api.post<{ id: string }>(`/reimbursements/lease/${leaseId}/invoices`, { from, to, exclude, terms }).then(r => r.data);
export const updateReimbursementInvoiceTerms = (id: string, terms: ReimbursementTerms) =>
  api.put(`/reimbursements/invoices/${id}/terms`, terms).then(r => r.data);
export const getReimbursementInvoice = (id: string) =>
  api.get<any>(`/reimbursements/invoices/${id}`).then(r => r.data);
export const recordReimbursementPayment = (id: string, amount: number, paidAt?: string, method?: string) =>
  api.post(`/reimbursements/invoices/${id}/payment`, { amount, paidAt, method }).then(r => r.data);
export const setReimbursementInvoiceStatus = (id: string, status: 'DRAFT' | 'SENT', notes?: string | null) =>
  api.patch(`/reimbursements/invoices/${id}`, { status, notes }).then(r => r.data);
export const deleteReimbursementInvoice = (id: string) =>
  api.delete(`/reimbursements/invoices/${id}`);

export interface Letterhead { name: string; address?: string | null; phone?: string | null; email?: string | null }
export const getLetterhead = () => api.get<Letterhead | null>('/reimbursements/letterhead').then(r => r.data);
export const saveLetterhead = (body: Letterhead) => api.put<Letterhead>('/reimbursements/letterhead', body).then(r => r.data);

// Rent reminders drafted by the collections assistant, for the owner to send.
export interface MessageDraftT {
  id: string; leaseId: string | null; kind: 'REMINDER' | 'FIRM'; toName: string | null; toEmail: string | null; toPhone: string | null;
  subject: string | null; body: string; sms: string | null; amountDue: number | null; status: string; createdAt: string;
}
export const getMessageDrafts = () => api.get<MessageDraftT[]>('/message-drafts').then(r => r.data);
export const draftRemindersNow = () => api.post<{ drafted: number; late: number }>('/message-drafts/draft-now').then(r => r.data);
export const markDraft = (id: string, action: 'sent' | 'dismiss') => api.post(`/message-drafts/${id}/${action}`);

// Schedule E worksheet: per property, cash basis.
export interface ScheduleELine { line: string; key: string; label: string }
export interface ScheduleEProperty { propertyId: string; name: string; address: string; lines: Record<string, number>; totalExpenses: number; net: number; capitalImprovements: number; finesExcluded: number; notes: string[] }
export interface ScheduleE { year: number; lines: ScheduleELine[]; properties: ScheduleEProperty[]; totals: Record<string, number>; totalExpenses: number; net: number }
export const getScheduleE = (year: number) => api.get<ScheduleE>('/tax-documents/schedule-e', { params: { year } }).then(r => r.data);
export const downloadScheduleECsv = (year: number) =>
  api.get('/tax-documents/schedule-e', { params: { year, format: 'csv' }, responseType: 'blob' }).then(r => r.data as Blob);

// Vault: records sealed in the browser; the server only holds ciphertext.
export interface VaultKeyInfo { setUp: boolean; salt?: string; iterations?: number; recoverySalt?: string; wrappedByPassphrase?: string; wrappedByRecovery?: string }
export interface VaultItemRow { id: string; kind: string; payload: string; createdAt: string; updatedAt: string }
export const getVaultKey = () => api.get<VaultKeyInfo>('/vault/key').then(r => r.data);
export const setupVault = (k: { salt: string; iterations: number; recoverySalt: string; wrappedByPassphrase: string; wrappedByRecovery: string }) => api.post('/vault/setup', k);
export const rekeyVault = (k: { salt: string; iterations: number; recoverySalt: string; wrappedByPassphrase: string; wrappedByRecovery: string; recovered?: boolean }) => api.put('/vault/key', k);
export const getVaultItems = () => api.get<VaultItemRow[]>('/vault/items').then(r => r.data);
export const createVaultItem = (kind: string, payload: string) => api.post<Omit<VaultItemRow, 'payload'>>('/vault/items', { kind, payload }).then(r => r.data);
export const updateVaultItem = (id: string, kind: string, payload: string) => api.put<Omit<VaultItemRow, 'payload'>>(`/vault/items/${id}`, { kind, payload }).then(r => r.data);
export const deleteVaultItem = (id: string) => api.delete(`/vault/items/${id}`);
export const vaultEvent = (action: 'UNLOCK' | 'UNLOCK_FAILED' | 'REVEAL' | 'COPY', itemId?: string) =>
  api.post<{ lockedUntil: string | null }>('/vault/events', { action, itemId }).then(r => r.data);
export const getVaultActivity = () => api.get<{ id: string; action: string; itemId: string | null; ip: string | null; userAgent: string | null; createdAt: string }[]>('/vault/activity').then(r => r.data);

// Shut-off, past-due and cancellation notices, tracked until resolved.
export interface ServiceNotice {
  id: string; kind: 'DISCONNECTION' | 'CANCELLATION' | 'PAST_DUE'; status: 'OPEN' | 'RESOLVED';
  provider: string | null; accountLast4: string | null; utilityAccountId: string | null; propertyId: string | null; property: string | null;
  noticeDate: string; cutoffDate: string | null; amountDemanded: number | null; summary: string | null;
  resolvedAt: string | null; resolvedReason: string | null;
}
export const getServiceNotices = (status: 'OPEN' | 'RESOLVED' | 'ALL' = 'OPEN') =>
  api.get<ServiceNotice[]>('/service-notices', { params: { status } }).then(r => r.data);
export const resolveServiceNotice = (id: string, reason?: string) => api.post(`/service-notices/${id}/resolve`, { reason });
export const reopenServiceNotice = (id: string) => api.post(`/service-notices/${id}/reopen`);

// Which providers' bills reach Sollux from Gmail, and which bill emails were not extracted.
export interface CoverageMessage { id: string; receivedAt: string | null; subject: string | null; from: string | null; mailbox: string; outcome: string; detail: string | null }
export interface GmailCoverage {
  since: string;
  providers: {
    provider: string; status: 'not_extracted' | 'partial' | 'no_email' | 'ok'; filed: number; notExtractedCount: number; notExtracted: CoverageMessage[];
    accounts: { utilityAccountId: string; propertyId: string; property: string; lastBill: string | null; lastBillSource: string | null; overdue: boolean }[];
  }[];
  unmatched: { from: string; name: string; domain: string; count: number; latest: CoverageMessage }[];
}
export const getGmailCoverage = () => api.get<GmailCoverage>('/gmail/coverage').then(r => r.data);

// ─── Billing (routes/billing.ts) ────────────────────────────────────────────
export type PlanKey = 'STARTER' | 'PRO' | 'PORTFOLIO';
export interface BillingSummary {
  access: 'comp' | 'trial' | 'active' | 'lapsed';
  plan: PlanKey | 'COMP' | null;
  status: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  lapsedReason: 'trial_ended' | 'past_due' | 'canceled' | 'unpaid' | null;
  usage: { properties: number; propertyLimit: number | null };
  plans: { key: PlanKey; name: string; priceMonthly: number; maxProperties: number | null; blurb: string }[];
  trialDays: number;
  billingConfigured: boolean;
  canManage: boolean;
  hasCustomer: boolean;
}
export const getBilling = () => api.get<BillingSummary>('/billing').then(r => r.data);
export const startCheckout = (plan: PlanKey) => api.post<{ url: string }>('/billing/checkout', { plan }).then(r => r.data);
export const openBillingPortal = () => api.post<{ url: string }>('/billing/portal').then(r => r.data);

// ─── AI spend and the AI test run (routes/aiSpend.ts) ─────────────
export interface AiSpendFeature { feature: string; name: string; test: boolean; calls: number; cost: number; avgCost: number; fallbacks: number; cachedShare: number }
export interface AiSpend {
  month: string; spent: number; budget: number | null; scope?: 'app' | 'account'; primaryModel: string; fallbackModel: string | null; portalRecipes: number;
  features: AiSpendFeature[];
  recent: { createdAt: string; feature: string; name: string; model: string; costUsd: number; fellBack: boolean; test: boolean; inputTokens: number; outputTokens: number; cacheReadTokens: number }[];
}
export interface AiTestResult { key: string; name: string; status: 'pending' | 'running' | 'ok' | 'problem' | 'skipped'; detail?: string; cost?: number; calls?: number; models?: string[]; fellBack?: boolean; ms?: number }
export interface AiTestState { checks: { key: string; name: string }[]; run: { startedAt: string; finishedAt?: string; results: AiTestResult[] } | null; apiKey: boolean }
export interface PortalRunStatus {
  state: 'queued' | 'running' | 'done' | 'failed'; stuck: boolean; progress: string | null; error: string | null;
  createdAt: string; startedAt: string | null; completedAt: string | null; statementsFound: number; costUsd: number | null;
}
export interface PortalTestAccount {
  id: string; providerName: string; last4: string | null; place: string; lastSyncStatus: string | null; lastSyncError: string | null; lastAgentRunAt: string | null;
  propertyId: string; hasCredentials: boolean; lookupName: string | null; lookupCustomerId?: string | null; website: string | null;
  /** What stands between it and a fetch: a portal login, the name on the bill (lookup page), or nothing to fetch (paid from escrow). */
  needs: 'login' | 'name' | 'escrow' | null;
  recipe: { successes: number; failures: number; updatedAt: string } | null;
  syncEnabled: boolean; mfaPrompt: string | null; mfaRequestedAt: string | null; run: PortalRunStatus | null;
}
export const getAiSpend = () => api.get<AiSpend>('/ai-spend').then(r => r.data);
export const getAiTest = () => api.get<AiTestState>('/ai-spend/test').then(r => r.data);
export const startAiTest = (only?: string) => api.post('/ai-spend/test', only ? { only } : {}).then(r => r.data);
export interface QueueSnapshot { waiting: number; active: { account: string; since: string | null; kind: string }[] }
export interface WorkerStatus { state: 'ok' | 'busy' | 'paused' | 'stopped' | 'never'; name: string | null; lastSeen: string | null; active: number; message: string }
export const getPortalTests = () => api.get<{ accounts: PortalTestAccount[]; sharedRecipes: { host: string; successes: number; failures: number }[]; monthCalls: number; monthCost: number; workers: WorkerStatus; queue: QueueSnapshot | null }>('/ai-spend/test/portal').then(r => r.data);
export const testPortal = (accountId: string) => api.post(`/ai-spend/test/portal/${accountId}`).then(r => r.data);


// ─── Rent collection, the tenant portal, repairs ──────────────────
export type PayMethod = 'card' | 'us_bank_account';
export interface Fees { charge: number; tenantFee: number; ownerReceives: number; stripeFee: number }
export interface RentCollectionStatus {
  configured: boolean; connected: boolean; chargesEnabled: boolean; payoutsEnabled: boolean; needsInfo: boolean; error?: string; canManage: boolean;
  example: { rent: number; card: Fees; bank: Fees }; tenants: { invited: number; joined: number; autopay: number };
  /** What the tenant portal needs before tenants use it, checked live on the server. */
  setup?: { key: string; label: string; ok: boolean; detail: string }[];
}
export interface PortalInviteCandidate { id: string; fullName: string; email: string | null; place: string }
export const getInviteAll = () => api.get<{ tenants: PortalInviteCandidate[]; emailConfigured: boolean }>('/rent-collection/invite-all').then(r => r.data);
export const inviteAll = (tenantIds: string[]) => api.post<{ invited: (PortalInviteCandidate & { link: string; emailed: boolean })[] }>('/rent-collection/invite-all', { tenantIds }).then(r => r.data);
export const getRentCollection = () => api.get<RentCollectionStatus>('/rent-collection').then(r => r.data);
export const connectRentPayouts = () => api.post<{ url: string }>('/rent-collection/connect').then(r => r.data);
export const openPayoutsDashboard = () => api.post<{ url: string }>('/rent-collection/dashboard').then(r => r.data);
export interface PortalInvite { invited: boolean; joined: boolean; autopay?: boolean; invitedAt?: string; acceptedAt?: string | null; email?: string | null; link?: string | null }
export const getPortalInvite = (tenantId: string) => api.get<PortalInvite>(`/rent-collection/tenants/${tenantId}/invite`).then(r => r.data);
export const sendPortalInvite = (tenantId: string, body: { email?: string; resetSignIn?: boolean } = {}) => api.post<{ link: string; emailed: boolean; email: string | null }>(`/rent-collection/tenants/${tenantId}/invite`, body).then(r => r.data);
export const revokePortalInvite = (tenantId: string) => api.delete(`/rent-collection/tenants/${tenantId}/invite`).then(r => r.data);

export interface RepairRow {
  id: string; title: string; category: string; urgency: 'EMERGENCY' | 'URGENT' | 'ROUTINE'; status: string; createdAt: string; scheduledFor: string | null; completedAt: string | null;
  cost?: number | null; photos?: number; updates?: number; createdBy?: string; propertyId?: string; property?: string; unit?: string | null; tenant?: string | null;
}
export interface RepairUpdate { id: string; author: 'OWNER' | 'TENANT'; body: string; createdAt: string }
export interface RepairDetail extends RepairRow {
  description: string; permissionToEnter: boolean; availability: string | null; vendor?: string | null; expenseId?: string | null; tenantId?: string | null;
  photos: string[] | any; updates: RepairUpdate[] | any; tenant?: any;
}
export interface PhotoUpload { name: string; data: string }
export const getRepairs = (status = 'active') => api.get<RepairRow[]>('/maintenance', { params: { status } }).then(r => r.data);
export const getRepair = (id: string) => api.get<RepairDetail>(`/maintenance/${id}`).then(r => r.data);
export const createRepair = (body: { propertyId: string; unitId?: string | null; tenantId?: string | null; title: string; description: string; category: string; urgency: string; photos?: PhotoUpload[] }) => api.post<{ id: string }>('/maintenance', body).then(r => r.data);
export const updateRepair = (id: string, body: { status?: string; urgency?: string; scheduledFor?: string | null; vendor?: string | null; cost?: number | null; note?: string }) => api.patch(`/maintenance/${id}`, body).then(r => r.data);
export const addRepairNote = (id: string, body: string) => api.post(`/maintenance/${id}/updates`, { body }).then(r => r.data);
export const logRepairExpense = (id: string, amount?: number) => api.post<{ expenseId: string }>(`/maintenance/${id}/expense`, amount ? { amount } : {}).then(r => r.data);

// The tenant's own side (routes/portal.ts)
export interface PortalLease {
  id: string; rent: number; dueDay: number; startDate: string | null; endDate: string | null; leaseType: string; hasDocument: boolean; lateFee: number | string | null; graceDays: number | null;
  address: string; city: string; balance: { periodDate: string; thisMonth: number; arrears: number; total: number; pending: number };
}
export interface PortalMe {
  tenant: { fullName: string; email: string | null; phone: string | null } | null; landlord: string; onlinePayments: boolean;
  autopay: { on: boolean; label: string | null; method: string | null }; leases: PortalLease[];
}
export interface PortalPayment { id: string; amount: number; paidDate: string; periodDate: string; method: string; status: 'PENDING' | 'RECEIVED'; tenantFee: number | null; online: boolean }
export const claimPortalInvite = (token: string) => api.post('/portal/claim', { token }).then(r => r.data);
export const getPortalMe = () => api.get<PortalMe>('/portal/me').then(r => r.data);
export const getPortalFees = (amount: number) => api.get<{ card: Fees; bank: Fees }>('/portal/fees', { params: { amount } }).then(r => r.data);
export const getPortalPayments = () => api.get<PortalPayment[]>('/portal/payments').then(r => r.data);
export const payRent = (body: { leaseId: string; amount: number; method: PayMethod }) => api.post<{ url: string }>('/portal/pay', body).then(r => r.data);
export const setupAutopay = (method: PayMethod) => api.post<{ url: string }>('/portal/autopay', { method }).then(r => r.data);
export const stopAutopay = () => api.delete('/portal/autopay').then(r => r.data);
export const getPortalLeaseDocument = (leaseId: string) => api.get<{ url: string }>(`/portal/leases/${leaseId}/document`).then(r => r.data);
export const getPortalRepairs = () => api.get<RepairRow[]>('/portal/requests').then(r => r.data);
export const getPortalRepair = (id: string) => api.get<RepairDetail>(`/portal/requests/${id}`).then(r => r.data);
export const createPortalRepair = (body: { leaseId: string; title: string; description: string; category: string; urgency: string; permissionToEnter: boolean; availability?: string; photos: PhotoUpload[] }) => api.post<{ id: string; photosSaved: number; photosFailed: number }>('/portal/requests', body).then(r => r.data);
export const addPortalRepairNote = (id: string, body: string) => api.post(`/portal/requests/${id}/updates`, { body }).then(r => r.data);

// ─── The Sollux connector: portal fetches through a Chrome on the owner's computer ──
export interface ConnectorDevice { id: string; name: string; createdAt: string; lastSeenAt: string | null; agent: string | null; online: boolean }
export const getConnectorDevices = () => api.get<{ devices: ConnectorDevice[] }>('/connector').then(r => r.data.devices);
export const createConnectorDevice = (name: string) => api.post<{ id: string; name: string; token: string }>('/connector', { name }).then(r => r.data);
export const removeConnectorDevice = (id: string) => api.delete(`/connector/${id}`).then(r => r.data);
/** The API's own address (no /api), which the connector on the owner's computer dials. */
export const apiOrigin = () => {
  const base = (import.meta.env.VITE_API_URL as string | undefined) || '/api';
  return new URL(base, window.location.origin).toString().replace(/\/api\/?$/, '').replace(/\/+$/, '');
};

/** Who rent is payable to on 3-day notices (the account's own details). */
export interface RentPayableTo { name: string; phone: string; email: string; address: string }
export const getRentPayableTo = () => api.get<{ payableTo: RentPayableTo | null }>('/account/payable-to').then(r => r.data.payableTo);
export const saveRentPayableTo = (p: RentPayableTo) => api.put<{ payableTo: RentPayableTo }>('/account/payable-to', p).then(r => r.data.payableTo);
