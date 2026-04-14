export type SubscriptionTier = 'BASIC' | 'PRO' | 'BUSINESS';
export type PropertyType = 'PRIMARY' | 'RENTAL' | 'INVESTMENT' | 'COMMERCIAL';
export type UtilityCategory =
  | 'ELECTRIC' | 'GAS' | 'WATER' | 'SEWER' | 'TRASH'
  | 'SOLAR' | 'INTERNET' | 'PHONE' | 'INSURANCE' | 'HOA' | 'TAXES' | 'OTHER';
export type InsightType = 'ANOMALY' | 'SAVINGS' | 'REMINDER' | 'INFO' | 'OUTAGE';
export type InsightSeverity = 'INFO' | 'WARNING' | 'ALERT';
export type PaymentStatus = 'PAID' | 'PENDING' | 'FAILED' | 'PARTIAL';
export type SyncStatus = 'SUCCESS' | 'FAILED' | 'PENDING' | 'PARTIAL';

export interface User {
  id: string;
  email: string;
  fullName: string;
  phone?: string;
  subscriptionTier: SubscriptionTier;
  createdAt: string;
}

export interface Property {
  id: string;
  userId: string;
  nickname?: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  type: PropertyType;
  createdAt: string;
  utilityAccounts?: UtilityAccount[];
  insights?: AIInsight[];
  _count?: { insights: number };
}

export interface UtilityAccount {
  id: string;
  propertyId: string;
  providerName: string;
  providerSlug: string;
  accountNumber?: string;
  loginUrl?: string;
  category: UtilityCategory;
  notes?: string;
  syncEnabled: boolean;
  lastSyncedAt?: string;
  lastSyncStatus?: SyncStatus;
  lastSyncError?: string;
  createdAt: string;
  statements?: Statement[];
  payments?: Payment[];
}

export interface Statement {
  id: string;
  utilityAccountId: string;
  statementDate: string;
  dueDate?: string;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  amountDue?: number;
  amountPaid?: number;
  balance?: number;
  usageValue?: number;
  usageUnit?: string;
  ratePlan?: string;
  pdfS3Key?: string;
  createdAt: string;
  // rawDataJson carries provider-specific fields:
  // pastDue, currentCharges, accountName, accountNumber, serviceAddress
  rawDataJson?: Record<string, unknown>;
  utilityAccount?: Pick<UtilityAccount, 'providerName' | 'category'> & {
    property?: Pick<Property, 'address' | 'nickname'>;
  };
}

export interface Payment {
  id: string;
  utilityAccountId: string;
  statementId?: string;
  amount: number;
  paymentDate: string;
  confirmationNumber?: string;
  paymentMethod?: string;
  status: PaymentStatus;
  notes?: string;
  createdAt: string;
  utilityAccount?: {
    propertyId?: string;
    providerName: string;
    category: UtilityCategory;
    property?: Pick<Property, 'id' | 'address' | 'nickname'>;
  };
}

export interface AIInsight {
  id: string;
  propertyId: string;
  utilityAccountId?: string;
  insightType: InsightType;
  severity: InsightSeverity;
  title: string;
  body: string;
  recommendation?: string;
  potentialSavings?: number;
  isRead: boolean;
  isDismissed: boolean;
  createdAt: string;
  property?: Pick<Property, 'address' | 'nickname' | 'city'>;
  utilityAccount?: Pick<UtilityAccount, 'providerName' | 'category'>;
}

export interface DashboardSummary {
  totalProperties: number;
  totalUtilityAccounts: number;
  monthlyTotal: number;
  unreadInsights: number;
  alertInsights: number;
  billsDueSoon: number;
}

// ─── UI helpers ───────────────────────────────────────────

export const CATEGORY_LABELS: Record<UtilityCategory, string> = {
  ELECTRIC: 'Electric', GAS: 'Gas', WATER: 'Water', SEWER: 'Sewer',
  TRASH: 'Trash', SOLAR: 'Solar', INTERNET: 'Internet', PHONE: 'Phone',
  INSURANCE: 'Insurance', HOA: 'HOA', TAXES: 'Taxes', OTHER: 'Other',
};

export const CATEGORY_COLORS: Record<UtilityCategory, string> = {
  ELECTRIC: '#F5A623', GAS: '#5DCAA5', WATER: '#378ADD', SEWER: '#7F77DD',
  TRASH: '#888780', SOLAR: '#EF9F27', INTERNET: '#D4537E', PHONE: '#F0997B',
  INSURANCE: '#E24B4A', HOA: '#1D9E75', TAXES: '#534AB7', OTHER: '#B4B2A9',
};

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  PRIMARY: 'Primary home', RENTAL: 'Rental', INVESTMENT: 'Investment', COMMERCIAL: 'Commercial',
};

export const SEVERITY_PILL: Record<InsightSeverity, string> = {
  ALERT: 'pill-red', WARNING: 'pill-amber', INFO: 'pill-blue',
};
