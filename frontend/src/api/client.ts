import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
});

api.interceptors.request.use(async (config) => {
  try {
    // @ts-ignore — Clerk is loaded globally via ClerkProvider
    const token = await window.Clerk?.session?.getToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  } catch { /* no-op */ }
  return config;
});

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) window.location.href = '/sign-in';
    return Promise.reject(err);
  }
);

export default api;

import type {
  Property, UtilityAccount, Statement, Payment, AIInsight, DashboardSummary,
  Unit, Tenant, Lease, RentPayment, RentNotice, Expense, Loan, LoanPayment,
  InsurancePolicy, TaxAssessment, Improvement, LegalMatter, PropertyPnL, MonthlyPnL,
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

// Units
export const getUnits = (params?: { propertyId?: string }) =>
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

// Rent payments
export const getRentPayments = (params?: { leaseId?: string; propertyId?: string }) =>
  api.get<RentPayment[]>('/rent-payments', { params }).then(r => r.data);
export const createRentPayment = (data: any) =>
  api.post<RentPayment>('/rent-payments', data).then(r => r.data);
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
export const createLoan = (data: Partial<Loan>) =>
  api.post<Loan>('/loans', data).then(r => r.data);
export const updateLoan = (id: string, data: Partial<Loan>) =>
  api.patch<Loan>(`/loans/${id}`, data).then(r => r.data);
export const deleteLoan = (id: string) =>
  api.delete(`/loans/${id}`);
export const getLoanPayments = (loanId: string) =>
  api.get<LoanPayment[]>(`/loans/${loanId}/payments`).then(r => r.data);
export const createLoanPayment = (loanId: string, data: Partial<LoanPayment>) =>
  api.post<LoanPayment>(`/loans/${loanId}/payments`, data).then(r => r.data);
export const deleteLoanPayment = (loanId: string, paymentId: string) =>
  api.delete(`/loans/${loanId}/payments/${paymentId}`);

// Insurance
export const getInsurancePolicies = (params?: { propertyId?: string }) =>
  api.get<InsurancePolicy[]>('/insurance', { params }).then(r => r.data);
export const createInsurancePolicy = (data: Partial<InsurancePolicy>) =>
  api.post<InsurancePolicy>('/insurance', data).then(r => r.data);
export const updateInsurancePolicy = (id: string, data: Partial<InsurancePolicy>) =>
  api.patch<InsurancePolicy>(`/insurance/${id}`, data).then(r => r.data);
export const deleteInsurancePolicy = (id: string) =>
  api.delete(`/insurance/${id}`);

// Taxes
export const getTaxAssessments = (params?: { propertyId?: string }) =>
  api.get<TaxAssessment[]>('/taxes', { params }).then(r => r.data);
export const createTaxAssessment = (data: Partial<TaxAssessment>) =>
  api.post<TaxAssessment>('/taxes', data).then(r => r.data);
export const updateTaxAssessment = (id: string, data: Partial<TaxAssessment>) =>
  api.patch<TaxAssessment>(`/taxes/${id}`, data).then(r => r.data);
export const deleteTaxAssessment = (id: string) =>
  api.delete(`/taxes/${id}`);

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
export const getLegalMatters = (params?: { propertyId?: string; status?: string }) =>
  api.get<LegalMatter[]>('/legal', { params }).then(r => r.data);
export const createLegalMatter = (data: Partial<LegalMatter>) =>
  api.post<LegalMatter>('/legal', data).then(r => r.data);
export const updateLegalMatter = (id: string, data: Partial<LegalMatter>) =>
  api.patch<LegalMatter>(`/legal/${id}`, data).then(r => r.data);
export const deleteLegalMatter = (id: string) =>
  api.delete(`/legal/${id}`);

// P&L
export const getPortfolioPnL = (params?: { start?: string; end?: string }) =>
  api.get<{ byProperty: PropertyPnL[]; totals: PropertyPnL }>('/pnl/portfolio', { params }).then(r => r.data);
export const getPropertyPnL = (id: string, params?: { start?: string; end?: string }) =>
  api.get<PropertyPnL>(`/pnl/property/${id}`, { params }).then(r => r.data);
export const getMonthlyPnL = (params?: { year?: number; propertyId?: string }) =>
  api.get<MonthlyPnL[]>('/pnl/monthly', { params }).then(r => r.data);

// Utility accounts
export const getUtilities = (propertyId?: string) =>
  api.get<UtilityAccount[]>('/utilities', { params: { propertyId } }).then(r => r.data);
export const getUtility = (id: string) =>
  api.get<UtilityAccount & { statements: any[]; payments: any[] }>(`/utilities/${id}`).then(r => r.data);
export const createUtility = (data: Partial<UtilityAccount> & { username?: string; password?: string }) =>
  api.post<UtilityAccount>('/utilities', data).then(r => r.data);
export const updateUtility = (id: string, data: any) =>
  api.patch<UtilityAccount>(`/utilities/${id}`, data).then(r => r.data);
export const deleteUtility = (id: string) =>
  api.delete(`/utilities/${id}`);
export const syncUtility = (id: string) =>
  api.post<{ jobId: string }>(`/utilities/${id}/sync`).then(r => r.data);

// Statements
export const getStatements = (params: { utilityAccountId?: string; propertyId?: string }) =>
  api.get<Statement[]>('/statements', { params }).then(r => r.data);
export const getStatementDownloadUrl = (id: string) =>
  api.get<{ url: string }>(`/statements/${id}/download`).then(r => r.data);
export const deleteStatement = (id: string) =>
  api.delete<{ success: boolean }>(`/statements/${id}`).then(r => r.data);

// Utility payments
export const getPayments = (params: { utilityAccountId?: string; propertyId?: string }) =>
  api.get<Payment[]>('/payments', { params }).then(r => r.data);
export const createPayment = (data: any) =>
  api.post<Payment>('/payments', data).then(r => r.data);

// Insights
export const getInsights = (params?: { propertyId?: string; severity?: string; type?: string; unread?: boolean }) =>
  api.get<AIInsight[]>('/insights', { params }).then(r => r.data);
export const markInsightRead = (id: string) =>
  api.patch<AIInsight>(`/insights/${id}/read`).then(r => r.data);
export const dismissInsight = (id: string) =>
  api.patch<AIInsight>(`/insights/${id}/dismiss`).then(r => r.data);

// Notifications
export const getNotificationPreferences = () =>
  api.get('/notifications/preferences').then(r => r.data);
export const updateNotificationPreferences = (data: any) =>
  api.patch('/notifications/preferences', data).then(r => r.data);

// Gmail
export const getGmailConnectUrl = () =>
  api.post<{ url: string }>('/gmail/connect').then(r => r.data);
export const getGmailStatus = () =>
  api.get<{ connected: boolean; email?: string }>('/gmail/status').then(r => r.data);
export const syncGmail = () =>
  api.post<{ jobId: string }>('/gmail/sync').then(r => r.data);

// Payment plans
export const getPaymentPlan = (utilityAccountId: string) =>
  api.get(`/utilities/${utilityAccountId}/payment-plan`).then(r => r.data).catch(() => null);
export const createPaymentPlan = (utilityAccountId: string, data: {
  totalAmount: number; monthlyAmount: number; startDate: string; description?: string;
}) => api.post(`/utilities/${utilityAccountId}/payment-plan`, data).then(r => r.data);
export const updatePaymentPlan = (utilityAccountId: string, data: {
  applyPayment?: number; remainingBalance?: number; monthlyAmount?: number;
  status?: string; description?: string;
}) => api.patch(`/utilities/${utilityAccountId}/payment-plan`, data).then(r => r.data);
export const deletePaymentPlan = (utilityAccountId: string) =>
  api.delete(`/utilities/${utilityAccountId}/payment-plan`);
