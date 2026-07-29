export type SubscriptionTier = 'BASIC' | 'PRO' | 'BUSINESS';
export type PropertyType =
  | 'PRIMARY' | 'RENTAL' | 'INVESTMENT' | 'COMMERCIAL'
  | 'RESIDENTIAL_SINGLE' | 'RESIDENTIAL_MULTI' | 'LAND' | 'GOLF_COURSE' | 'OTHER';
export type PropertyStatus = 'ACTIVE' | 'SOLD' | 'UNDER_CONTRACT' | 'INACTIVE';
export type UtilityCategory =
  | 'ELECTRIC' | 'GAS' | 'WATER' | 'SEWER' | 'TRASH'
  | 'SOLAR' | 'INTERNET' | 'PHONE' | 'INSURANCE' | 'HOA' | 'TAXES' | 'OTHER';
export type InsightType = 'ANOMALY' | 'SAVINGS' | 'REMINDER' | 'INFO' | 'OUTAGE';
export type InsightSeverity = 'INFO' | 'WARNING' | 'ALERT';
export type PaymentStatus = 'PAID' | 'PENDING' | 'FAILED' | 'PARTIAL';
export type BillStatus = 'UNPAID' | 'PAID' | 'ON_PAYMENT_PLAN' | 'PAST_DUE';
export type SyncStatus = 'SUCCESS' | 'FAILED' | 'PENDING' | 'PARTIAL';
export type LeaseType = 'FIXED_TERM' | 'MONTH_TO_MONTH';
export type LeaseStatus = 'ACTIVE' | 'ENDED' | 'PENDING' | 'TERMINATED';
export type RentPaymentMethod = 'CASH' | 'CHECK' | 'ZELLE' | 'ACH' | 'MONEY_ORDER' | 'CARD' | 'OTHER';
export type LoanType = 'MORTGAGE' | 'HELOC' | 'AUTO' | 'PERSONAL' | 'STUDENT' | 'INSTALLMENT_PLAN' | 'CREDIT_LINE' | 'OTHER';
export type InsuranceType = 'PROPERTY' | 'LIABILITY' | 'FLOOD' | 'UMBRELLA' | 'OTHER';
export type PremiumFrequency = 'MONTHLY' | 'ANNUAL' | 'SEMI_ANNUAL';
export type TaxStatus = 'UNPAID' | 'PAID' | 'PARTIALLY_PAID' | 'DELINQUENT';
export type LegalStatus = 'OPEN' | 'CLOSED' | 'ON_HOLD';
export type ExpenseCategory =
  | 'UTILITIES' | 'REPAIRS_MAINTENANCE' | 'LANDSCAPING' | 'PROPERTY_MANAGEMENT'
  | 'LEGAL' | 'INSURANCE' | 'PROPERTY_TAX' | 'HOA' | 'MORTGAGE_DEBT_SERVICE'
  | 'CAPITAL_IMPROVEMENT' | 'SUPPLIES' | 'TRAVEL' | 'ADVERTISING' | 'OTHER';

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
  addressLine2?: string;
  city: string;
  county?: string;
  state: string;
  zip: string;
  country: string;
  region?: string;
  type: PropertyType;
  status: PropertyStatus;
  acquisitionDate?: string;
  acquisitionPrice?: number;
  ownerEntity?: string;
  notes?: string;
  estimatedValue?: number;
  landValue?: number;
  valuationDate?: string;
  valuationNotes?: string;
  lotSqft?: number;
  parcelGroupName?: string;
  createdAt: string;
  utilityAccounts?: UtilityAccount[];
  insights?: AIInsight[];
  units?: Unit[];
  _count?: { insights: number };
}

export interface Unit {
  id: string;
  propertyId: string;
  unitLabel: string;
  bedrooms?: number;
  bathrooms?: number;
  sqft?: number;
  notes?: string;
  leases?: Lease[];
}

export interface Tenant {
  id: string;
  userId: string;
  fullName: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  createdAt: string;
  leaseTenants?: LeaseTenant[];
}

export interface LeaseTenant {
  id: string;
  leaseId: string;
  tenantId: string;
  tenant: Tenant;
  lease?: Lease;
  isPrimary: boolean;
}

export interface Lease {
  id: string;
  unitId: string;
  unit?: Unit & { property?: Pick<Property, 'id' | 'address' | 'nickname'> };
  startDate: string;
  endDate?: string;
  rentAmount: number;
  section8Amount?: number;
  securityDeposit?: number;
  leaseType: LeaseType;
  status: LeaseStatus;
  documentUrl?: string;
  notes?: string;
  arrearsBalance: number;
  arrearsCaughtUpThrough?: string;
  createdAt: string;
  leaseTenants?: LeaseTenant[];
  rentPayments?: RentPayment[];
  rentNotices?: RentNotice[];
}

export interface RentPayment {
  id: string;
  leaseId: string;
  periodDate: string;
  amount: number;
  appliedToArrears: number;
  paidDate: string;
  method: RentPaymentMethod;
  notes?: string;
  createdAt: string;
  lease?: Lease & { unit?: Unit & { property?: Pick<Property, 'id' | 'address' | 'nickname'> } };
}

export interface RentNotice {
  id: string;
  leaseId: string;
  noticeDate: string;
  lineItems: { amount: number; dueDate: string }[];
  totalDue: number;
  signedByName: string;
  signedByPhone?: string;
  signedByEmail?: string;
  signedByAddress?: string;
  createdAt: string;
  lease?: Lease & { unit?: Unit & { property?: Property }; leaseTenants?: LeaseTenant[] };
}

export interface Expense {
  id: string;
  propertyId: string;
  category: ExpenseCategory;
  amount: number;
  date: string;
  vendor?: string;
  description?: string;
  isCapEx: boolean;
  isPersonal: boolean;
  documentUrl?: string;
  createdAt: string;
  property?: Pick<Property, 'id' | 'address' | 'nickname'>;
}

export interface PrepaymentPenaltyTier {
  startMonth: number;
  endMonth: number;
  rate: number;
}

export interface PrepaymentPenalty {
  enabled: boolean;
  periodMonths: number;
  tiers: PrepaymentPenaltyTier[];
}

export interface Loan {
  id: string;
  propertyId?: string;
  userId: string;
  loanType: LoanType;
  lender: string;
  accountLast4?: string;
  originalAmount?: number;
  interestRate?: number;
  originationDate?: string;
  maturityDate?: string;
  monthlyPayment?: number;
  escrowAmount?: number;
  currentBalance?: number;
  dueDay?: number;
  gracePeriodDays?: number;
  paymentType?: string;
  prepaymentPenaltyJson?: PrepaymentPenalty | null;
  notes?: string;
  isPersonal: boolean;
  isActive: boolean;
  createdAt: string;
  property?: Pick<Property, 'id' | 'address' | 'nickname'>;
  loanPayments?: LoanPayment[];
  interestPaidToDate?: number;
  totalInterestLifetime?: number | null;
}

export interface LoanPayment {
  id: string;
  loanId: string;
  date: string;
  billAmount?: number;
  amount: number;
  lateFee?: number;
  status: BillStatus;
  principal?: number;
  interest?: number;
  escrow?: number;
  balanceAfter?: number;
  confirmationNumber?: string;
  notes?: string;
}

export interface InsurancePolicy {
  id: string;
  propertyId: string;
  carrier: string;
  policyNumber?: string;
  policyType: InsuranceType;
  premiumAmount: number;
  premiumFrequency: PremiumFrequency;
  effectiveDate?: string;
  expirationDate?: string;
  documentUrl?: string;
  notes?: string;
  isPersonal: boolean;
  isActive: boolean;
  property?: Pick<Property, 'id' | 'address' | 'nickname'>;
}

export interface TaxAssessment {
  id: string;
  propertyId: string;
  taxYear: string;
  assessedValue?: number;
  annualTaxAmount: number;
  installment1Due?: string;
  installment2Due?: string;
  installment1Paid?: string;
  installment2Paid?: string;
  status: TaxStatus;
  notes?: string;
  property?: Pick<Property, 'id' | 'address' | 'nickname'>;
}

export interface Improvement {
  id: string;
  propertyId: string;
  description: string;
  category?: string;
  cost: number;
  contractor?: string;
  startDate?: string;
  completionDate?: string;
  documentUrl?: string;
  notes?: string;
  property?: Pick<Property, 'id' | 'address' | 'nickname'>;
}

export interface LegalMatter {
  id: string;
  propertyId?: string;
  userId: string;
  title: string;
  matterType: string;
  status: LegalStatus;
  filedDate?: string;
  closedDate?: string;
  attorney?: string;
  caseNumber?: string;
  description?: string;
  documentUrl?: string;
  createdAt: string;
  property?: Pick<Property, 'id' | 'address' | 'nickname'>;
}

export interface PropertyPnL {
  propertyId: string;
  propertyName: string;
  rentalIncome: number;
  operatingExpenses: number;
  insuranceExpense: number;
  propertyTaxExpense: number;
  noi: number;
  debtService: number;
  cashFlow: number;
}

export interface MonthlyPnL {
  month: string;
  label: string;
  rentalIncome: number;
  operatingExpenses: number;
  insuranceExpense: number;
  propertyTaxExpense: number;
  noi: number;
  debtService: number;
  cashFlow: number;
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
  hasCredentials?: boolean;
  isActive: boolean;
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
  RESIDENTIAL_SINGLE: 'Single-family', RESIDENTIAL_MULTI: 'Multi-family',
  LAND: 'Land', GOLF_COURSE: 'Golf course', OTHER: 'Other',
};

export const SEVERITY_PILL: Record<InsightSeverity, string> = {
  ALERT: 'pill-red', WARNING: 'pill-amber', INFO: 'pill-blue',
};

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  UTILITIES: 'Utilities', REPAIRS_MAINTENANCE: 'Repairs & Maintenance',
  LANDSCAPING: 'Landscaping', PROPERTY_MANAGEMENT: 'Property Management',
  LEGAL: 'Legal', INSURANCE: 'Insurance', PROPERTY_TAX: 'Property Tax',
  HOA: 'HOA', MORTGAGE_DEBT_SERVICE: 'Mortgage / Debt Service',
  CAPITAL_IMPROVEMENT: 'Capital Improvement', SUPPLIES: 'Supplies',
  TRAVEL: 'Travel', ADVERTISING: 'Advertising', OTHER: 'Other',
};

// ─── Budget / Bank ─────────────────────────────────────────

export type BankAccountType = 'CHECKING' | 'SAVINGS' | 'CREDIT_CARD' | 'CASH_POOL';
export type OtherIncomeCategory =
  | 'APPLIANCE_SERVICE' | 'APPLIANCE_DELIVERY' | 'APPLIANCE_SALE'
  | 'GOVERNMENT_BENEFIT' | 'INTERNATIONAL' | 'LOAN_RECEIVED'
  | 'SECURITY_DEPOSIT' | 'DEPOSIT_REFUND_IN' | 'LAUNDRY' | 'OTHER';

export interface BankAccount {
  id: string;
  name: string;
  last4?: string;
  bank?: string;
  accountType: BankAccountType;
  isActive: boolean;
  sortOrder: number;
  notes?: string;
  balance: number;
  creditLimit?: number;
  asOfDate?: string;
}

export interface OtherIncome {
  id: string;
  category: OtherIncomeCategory;
  description?: string;
  amount: number;
  receivedDate: string;
  method?: string;
  isRecurring: boolean;
  notes?: string;
  createdAt: string;
}

export interface BudgetRentRow {
  leaseId: string;
  tenant: string;
  tenantId: string | null;
  unit: string;
  property: string;
  propertyId: string;
  expected: number;
  collected: number;
  remaining: number;
  arrearsBalance: number;
  status: 'paid' | 'partial' | 'unpaid';
}

export interface BudgetMortgageRow {
  loanId: string;
  lender: string;
  property: string;
  monthlyPayment: number;
  paid: number;
  paidDate: string | null;
  status: 'paid' | 'unpaid';
}

export interface DelinquencyTenant {
  leaseId: string;
  tenant: string;
  tenantId: string | null;
  unit: string;
  property: string;
  propertyId: string;
  monthlyRent: number;
  arrears: number;
  lastPaymentDate: string | null;
  lastPaymentAmount: number;
  daysSincePay: number;
  recentMonthlyAvg: number;
  score: number;
  likelihood: 'high' | 'medium' | 'low' | 'none';
  expectedCollection: number;
}

export interface BudgetSummary {
  year: number;
  month: number;
  rent: {
    rows: BudgetRentRow[];
    expected: number;
    collected: number;
    outstanding: number;
  };
  mortgages: {
    rows: BudgetMortgageRow[];
    total: number;
    paid: number;
    unpaid: number;
  };
  otherIncome: { rows: OtherIncome[]; total: number };
  expenses: { total: number };
  bankAccounts: BankAccount[];
  cashSummary: { totalBankBalance: number; totalCash: number; totalCashOnHand: number };
  summary: {
    totalIncome: number;
    totalExpected: number;
    totalExpenses: number;
    realisticNet: number;
    idealNet: number;
  };
}

export const OTHER_INCOME_LABELS: Record<OtherIncomeCategory, string> = {
  APPLIANCE_SERVICE:   'Appliance – Service Call',
  APPLIANCE_DELIVERY:  'Appliance – Delivery',
  APPLIANCE_SALE:      'Appliance – Sale',
  GOVERNMENT_BENEFIT:  'Govt Benefit (SSI / Section 8)',
  INTERNATIONAL:       'International Transfer (TapTap)',
  LOAN_RECEIVED:       'Loan Received',
  SECURITY_DEPOSIT:    'Security Deposit Collected',
  DEPOSIT_REFUND_IN:   'Deposit Refund Received',
  LAUNDRY:             'Laundry Income',
  OTHER:               'Other',
};
