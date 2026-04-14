import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
});

// Attach Clerk session token to every request
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
    if (err.response?.status === 401) {
      window.location.href = '/sign-in';
    }
    return Promise.reject(err);
  }
);

export default api;

// ─── Typed API helpers ────────────────────────────────────

import type {
  Property, UtilityAccount, Statement, Payment,
  AIInsight, DashboardSummary,
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

// Utility accounts
export const getUtilities = (propertyId?: string) =>
  api.get<UtilityAccount[]>('/utilities', { params: { propertyId } }).then(r => r.data);

export const getUtility = (id: string) =>
  api.get<UtilityAccount & { statements: any[]; payments: any[] }>(`/utilities/${id}`).then(r => r.data);

export const createUtility = (data: Partial<UtilityAccount> & {
  username?: string; password?: string;
}) => api.post<UtilityAccount>('/utilities', data).then(r => r.data);

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

// Payments
export const getPayments = (params: { utilityAccountId?: string; propertyId?: string }) =>
  api.get<Payment[]>('/payments', { params }).then(r => r.data);

export const createPayment = (data: any) =>
  api.post<Payment>('/payments', data).then(r => r.data);

// Insights
export const getInsights = (params?: {
  propertyId?: string; severity?: string; type?: string; unread?: boolean;
}) => api.get<AIInsight[]>('/insights', { params }).then(r => r.data);

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
