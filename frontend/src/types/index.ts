export type SubscriptionTier = 'BASIC' | 'PRO' | 'BUSINESS';
export type PropertyType =
  | 'PRIMARY' | 'RENTAL' | 'INVESTMENT' | 'COMMERCIAL' | 'MIXED_USE'
  | 'RESIDENTIAL_SINGLE' | 'RESIDENTIAL_MULTI' | 'LAND' | 'GOLF_COURSE' | 'OTHER';
export type PropertyStatus = 'ACTIVE' | 'SOLD' | 'UNDER_CONTRACT' | 'INACTIVE';
export type UtilityCategory =
  | 'ELECTRIC' | 'GAS' | 'WATER' | 'SEWER' | 'TRASH'
  | 'SOLAR' | 'INTERNET' | 'PHONE' | 'INSURANCE' | 'HOA' | 'TAXES' | 'LOAN' | 'CREDIT_CARD' | 'OTHER';
export type InsightType = 'ANOMALY' | 'SAVINGS' | 'REMINDER' | 'INFO' | 'OUTAGE';
export type InsightSeverity = 'INFO' | 'WARNING' | 'ALERT';
export type PaymentStatus = 'PAID' | 'PENDING' | 'FAILED' | 'PARTIAL';
export type BillStatus = 'UNPAID' | 'PAID' | 'ON_PAYMENT_PLAN' | 'PAST_DUE';
export type SyncStatus = 'SUCCESS' | 'FAILED' | 'PENDING' | 'PARTIAL';
export type LeaseType = 'FIXED_TERM' | 'MONTH_TO_MONTH';
export type LeaseStatus = 'ACTIVE' | 'ENDED' | 'PENDING' | 'TERMINATED';
export type RentPaymentMethod =
  | 'CASH' | 'CHECK' | 'ZELLE' | 'ACH' | 'MONEY_ORDER' | 'CARD'
  | 'VENMO' | 'PAYPAL' | 'CASH_APP' | 'APPLE_CASH' | 'BANK_DEPOSIT'
  | 'RENTAL_ASSISTANCE' | 'OTHER';

// Committed but not yet disbursed vs. actually in hand. Pending money never
// counts toward a month's rent or pays down arrears.
export type RentPaymentStatus = 'PENDING' | 'RECEIVED';

// Ordered for the payment dropdown — most-used first, OTHER last.
export const RENT_PAYMENT_METHODS: RentPaymentMethod[] = [
  'ZELLE', 'CHECK', 'CASH', 'ACH', 'BANK_DEPOSIT', 'RENTAL_ASSISTANCE',
  'VENMO', 'CASH_APP', 'PAYPAL', 'APPLE_CASH', 'MONEY_ORDER', 'CARD', 'OTHER',
];

// Methods where the money lands in one of the owner's accounts, so it is worth
// recording which. Cash and the P2P apps sit in their own balances until they
// are moved, so asking there would be noise.
export const BANK_LINKED_METHODS: RentPaymentMethod[] = [
  'BANK_DEPOSIT', 'CHECK', 'ACH', 'MONEY_ORDER', 'ZELLE', 'RENTAL_ASSISTANCE',
];

export const RENT_PAYMENT_METHOD_LABELS: Record<RentPaymentMethod, string> = {
  ZELLE:        'Zelle',
  CHECK:        'Check',
  CASH:         'Cash',
  ACH:          'ACH / bank transfer',
  BANK_DEPOSIT: 'Deposited into bank',
  RENTAL_ASSISTANCE: 'Rental assistance',
  VENMO:        'Venmo',
  CASH_APP:     'Cash App',
  PAYPAL:       'PayPal',
  APPLE_CASH:   'Apple Cash',
  MONEY_ORDER:  'Money order',
  CARD:         'Card',
  OTHER:        'Other',
};
export type LoanType = 'MORTGAGE' | 'HELOC' | 'AUTO' | 'PERSONAL' | 'STUDENT' | 'INSTALLMENT_PLAN' | 'CREDIT_LINE' | 'SELLER_FINANCING' | 'DSCR' | 'COMMERCIAL' | 'HARD_MONEY' | 'OTHER';
export type InsuranceType = 'PROPERTY' | 'LIABILITY' | 'FLOOD' | 'UMBRELLA' | 'OTHER';
export type PremiumFrequency = 'MONTHLY' | 'ANNUAL' | 'SEMI_ANNUAL';
export type TaxStatus = 'UNPAID' | 'PAID' | 'PARTIALLY_PAID' | 'DELINQUENT';
export type LegalStatus =
  | 'OPEN' | 'PENDING_FILING' | 'FILED' | 'IN_LITIGATION' | 'DISCOVERY'
  | 'AWAITING_HEARING' | 'JUDGMENT' | 'APPEAL' | 'COLLECTIONS'
  | 'ON_HOLD' | 'SETTLED' | 'DISMISSED' | 'CLOSED';
export type ExpenseCategory =
  | 'UTILITIES' | 'REPAIRS_MAINTENANCE' | 'LANDSCAPING' | 'PROPERTY_MANAGEMENT'
  | 'LEGAL' | 'INSURANCE' | 'PROPERTY_TAX' | 'HOA' | 'MORTGAGE_DEBT_SERVICE'
  | 'CAPITAL_IMPROVEMENT' | 'SUPPLIES' | 'TRAVEL' | 'ADVERTISING' | 'OTHER'
  | 'AUTO_LOAN' | 'AUTO_INSURANCE' | 'CREDIT_CARD' | 'MEDICAL' | 'PHONE'
  | 'STUDENT_LOAN' | 'LIFE_INSURANCE' | 'SUBSCRIPTIONS';

export const PERSONAL_EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'AUTO_LOAN', 'AUTO_INSURANCE', 'CREDIT_CARD', 'MEDICAL', 'PHONE',
  'STUDENT_LOAN', 'LIFE_INSURANCE', 'SUBSCRIPTIONS', 'OTHER',
];

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
  rentDueDay?: number | null;
  nextIncreaseDate?: string | null;
  nextIncreaseAmount?: number | null;
  nextIncreasePercent?: number | null;
  nextIncreaseNote?: string | null;
  lateFeeAmount?: number | null;
  lateFeePercent?: number | null;
  lateFeeGraceDays?: number | null;
  businessName?: string | null;
  createdAt: string;
  leaseTenants?: LeaseTenant[];
  rentPayments?: RentPayment[];
  rentNotices?: RentNotice[];
  rentChanges?: RentChange[];
  scheduledIncreases?: ScheduledRentIncrease[];
  utilityCharges?: LeaseUtilityCharge[];
  paymentAliases?: LeasePaymentAlias[];
}

// A name this lease's rent may arrive under — a spouse, a relative, an
// employer, a housing authority. Matched against bank transaction descriptors.
export interface LeasePaymentAlias {
  id: string;
  leaseId: string;
  name: string;
  note?: string | null;
  createdAt: string;
}

// Portion of the tenant's monthly payment that reimburses a utility.
// rentAmount is the TOTAL they pay; base rent = rentAmount - sum(amount).
export interface LeaseUtilityCharge {
  id: string;
  leaseId: string;
  category: string;
  amount: number;
  note?: string | null;
  createdAt: string;
}

export interface RentChange {
  id: string;
  leaseId: string;
  effectiveDate: string;
  previousAmount?: number | null;
  newAmount: number;
  note?: string | null;
  createdAt: string;
}

export interface ScheduledRentIncrease {
  id: string;
  leaseId: string;
  effectiveDate: string;
  newAmount?: number | null;
  percent?: number | null;
  percentMax?: number | null;
  note?: string | null;
  applied: boolean;
  createdAt: string;
}

export interface RentPayment {
  id: string;
  leaseId: string;
  periodDate: string;
  amount: number;
  appliedToArrears: number;
  paidDate: string;
  method: RentPaymentMethod;
  status: RentPaymentStatus;
  expectedDate?: string | null;
  bankAccountId?: string | null;
  bankAccount?: Pick<BankAccount, 'id' | 'name' | 'bank' | 'last4'> | null;
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
  propertyId?: string | null;
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
  // 'utility' rows are read-only — merged in from scraped/imported utility
  // statements, not a real Expense record. Edit/delete at the source
  // (the utility account) instead of here.
  source?: 'manual' | 'utility';
  editable?: boolean;
  utilityAccountId?: string;
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

export interface ReconciliationLineItem {
  type: 'RENT' | 'LOAN_PAYMENT' | 'EXPENSE' | 'OTHER';
  targetId?: string | null;
  targetLabel?: string | null;
  description?: string | null;
  amount: number;
  direction: 'CREDIT' | 'DEBIT';
  date?: string | null; // YYYY-MM-DD — the date this line actually hit the account; falls back to statementDate
}

export interface ReconciliationProfile {
  id: string;
  name: string;
  propertyId?: string | null;
  property?: Pick<Property, 'id' | 'address' | 'nickname'> | null;
  leaseId?: string | null;
  managementFeeCategory?: string | null;
  loanIds: string[];
  notes?: string | null;
  createdAt: string;
}

export interface ReconciliationStatement {
  id: string;
  profileId: string;
  profile?: { id: string; name: string };
  statementDate: string;
  documentS3Key?: string | null;
  documentUrl?: string | null;
  lineItems: ReconciliationLineItem[];
  netAmount: number;
  status: 'DRAFT' | 'APPLIED';
  appliedAt?: string | null;
  createdRecordIds?: { rentPaymentIds: string[]; loanPaymentIds: string[]; expenseIds: string[] } | null;
  notes?: string | null;
  createdAt: string;
}

export type DocumentCategory =
  | 'UTILITY' | 'INSURANCE' | 'TAX' | 'LEGAL' | 'HOA' | 'EXPENSE_RECEIPT' | 'LEASE'
  | 'APPLICATION' | 'IDENTITY' | 'SCREENING' | 'MAINTENANCE'
  | 'CONTRACT' | 'COURT_FILING' | 'CORRESPONDENCE' | 'OTHER';

export interface Document {
  id: string;
  propertyId?: string | null;
  property?: Pick<Property, 'id' | 'address' | 'nickname'> | null;
  category: DocumentCategory;
  title: string;
  s3Key: string;
  s3Url?: string | null;
  pageCount: number;
  sourceType: string;
  linkedType?: string | null;
  linkedId?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface DocumentClassification {
  category: DocumentCategory;
  title: string;
  address: string | null;
  vendor: string | null;
  documentDate: string | null;
}

export interface DocumentMatch {
  confidence: 'high' | 'medium' | 'low' | 'none';
  propertyId: string | null;
  propertyName: string | null;
}

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  UTILITY: 'Utility',
  INSURANCE: 'Insurance',
  TAX: 'Tax',
  LEGAL: 'Legal',
  HOA: 'HOA',
  EXPENSE_RECEIPT: 'Expense receipt',
  LEASE: 'Lease agreement',
  APPLICATION: 'Application',
  IDENTITY: 'Identity / ID',
  SCREENING: 'Screening',
  MAINTENANCE: 'Maintenance',
  CONTRACT: 'Contract',
  COURT_FILING: 'Court filing',
  CORRESPONDENCE: 'Correspondence',
  OTHER: 'Other / Misc',
};

export type IncomingTransactionStatus = 'UNMATCHED' | 'SUGGESTED' | 'APPLIED' | 'IGNORED';
export type PaymentChannel = 'ZELLE' | 'VENMO' | 'PAYPAL' | 'CASH_APP' | 'APPLE_CASH' | 'OTHER';

export interface IncomingTransaction {
  id: string;
  bankAccountId: string;
  bankAccount?: { id: string; name: string; bank?: string | null };
  amount: number;
  date: string;
  name: string;
  channel?: PaymentChannel | null;
  matchedLeaseId?: string | null;
  matchedLease?: {
    id: string;
    unit: { unitLabel: string; property: { id: string; address: string; nickname?: string | null } };
    leaseTenants: { tenant: { fullName: string } }[];
  } | null;
  status: IncomingTransactionStatus;
  rentPaymentId?: string | null;
  createdAt: string;
}

export type OutgoingMatchType = 'HARDWARE' | 'UTILITY';

export interface UtilityCandidate {
  utilityAccountId: string;
  propertyId: string;
  propertyLabel: string;
  providerName: string;
  statementId: string;
  statementDate: string;
  amountDue: number;
  diff: number;
  withinTolerance: boolean;
}

export interface OutgoingTransaction {
  id: string;
  bankAccountId: string;
  bankAccount?: { id: string; name: string; bank?: string | null };
  amount: number;
  date: string;
  name: string;
  matchType?: OutgoingMatchType | null;
  propertyId?: string | null;
  property?: Pick<Property, 'id' | 'address' | 'nickname'> | null;
  utilityAccountId?: string | null;
  utilityAccount?: { id: string; providerName: string } | null;
  category?: ExpenseCategory | null;
  statementId?: string | null;
  status: IncomingTransactionStatus;
  appliedType?: string | null;
  appliedId?: string | null;
  createdAt: string;
}

export interface LoanExtension {
  id: string;
  loanId: string;
  months: number;
  previousMaturityDate?: string | null;
  newMaturityDate: string;
  notes?: string | null;
  extendedAt: string;
}

export interface IndexRate {
  id: string;
  indexName: string;
  rate: number;
  effectiveDate: string;
  notes?: string | null;
  createdAt: string;
}

export interface Loan {
  id: string;
  propertyId?: string;
  userId: string;
  loanType: LoanType;
  lender: string;
  accountLast4?: string;
  accountNumber?: string | null; // full number, only populated on GET /loans/:id
  originalAmount?: number;
  interestRate?: number;
  originationDate?: string;
  maturityDate?: string;
  monthlyPayment?: number;
  balloonPaymentAmount?: number;
  escrowAmount?: number;
  currentBalance?: number;
  dueDay?: number;
  gracePeriodDays?: number;
  paymentType?: string;
  paymentStructureChangedAt?: string | null;
  rateType?: 'FIXED' | 'VARIABLE';
  rateIndex?: string | null;
  rateMargin?: number | null; // signed: -1.0 = "1% below index", +2.0 = "2% above index"
  rateAdjustmentMonths?: number | null;
  nextRateAdjustment?: string | null;
  prepaymentPenaltyJson?: PrepaymentPenalty | null;
  notes?: string;
  isPersonal: boolean;
  isActive: boolean;
  createdAt: string;
  property?: Pick<Property, 'id' | 'address' | 'nickname'>;
  loanPayments?: LoanPayment[];
  loanExtensions?: LoanExtension[];
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
  utilityAccountId?: string | null;
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

export interface LegalEvent {
  id: string;
  legalMatterId: string;
  date: string;
  eventType: string;
  title: string;
  notes?: string | null;
  outcome?: string | null;
  isCompleted: boolean;
  createdAt: string;
}

export interface LegalFee {
  id: string;
  legalMatterId: string;
  date: string;
  category: string;
  description?: string | null;
  amount: number;
  hours?: number | null;
  hourlyRate?: number | null;
  payee?: string | null;
  invoiceNumber?: string | null;
  isPaid: boolean;
  paidDate?: string | null;
  bankAccountId?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface LegalMatter {
  id: string;
  propertyId?: string | null;
  leaseId?: string | null;
  userId: string;
  title: string;
  matterType: string;
  status: LegalStatus;
  priority?: string | null;
  filedDate?: string | null;
  closedDate?: string | null;
  nextHearingDate?: string | null;
  responseDueDate?: string | null;
  statuteDeadline?: string | null;
  attorney?: string | null;
  attorneyFirm?: string | null;
  attorneyEmail?: string | null;
  attorneyPhone?: string | null;
  court?: string | null;
  jurisdiction?: string | null;
  judge?: string | null;
  caseNumber?: string | null;
  opposingParty?: string | null;
  opposingCounsel?: string | null;
  claimAmount?: number | null;
  judgmentAmount?: number | null;
  amountCollected?: number | null;
  settlementAmount?: number | null;
  outcome?: string | null;
  description?: string | null;
  notes?: string | null;
  documentUrl?: string | null;
  createdAt: string;
  property?: Pick<Property, 'id' | 'address' | 'nickname'> | null;
  lease?: {
    id: string;
    unit?: { unitLabel: string; property?: Pick<Property, 'id' | 'address' | 'nickname'> };
    leaseTenants?: { tenant: { id: string; fullName: string } }[];
  } | null;
  events?: LegalEvent[];
  fees?: LegalFee[];
  documents?: Document[];
}

export interface LegalSummary {
  totalMatters: number;
  openMatters: number;
  byType: Record<string, number>;
  totalFees: number;
  unpaidFees: number;
  claimExposure: number;
  judgmentsAwarded: number;
  judgmentsCollected: number;
  overdueDeadlines: number;
  upcoming: { matterId: string; title: string; kind: string; date: string }[];
}

// Free text in the database — this is the canonical list the UI offers, so a
// state-specific or unusual matter can still be typed in.
export const LEGAL_MATTER_TYPES: string[] = [
  'Eviction', 'Unlawful detainer', 'Notice to quit', 'Rent collection',
  'Lease dispute', 'Security deposit dispute', 'Habitability claim',
  'Lawsuit (defendant)', 'Lawsuit (plaintiff)', 'Small claims',
  'Contract dispute', 'Construction defect', 'Insurance claim / dispute',
  'Personal injury', 'Property damage', 'Code violation', 'HOA dispute',
  'Boundary / easement', 'Title dispute', 'Lien / mechanics lien',
  'Foreclosure', 'Bankruptcy (tenant)', 'Zoning / permitting',
  'Fair housing complaint', 'Collections / judgment enforcement', 'Other',
];

export const LEGAL_STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open', PENDING_FILING: 'Pending filing', FILED: 'Filed',
  IN_LITIGATION: 'In litigation', DISCOVERY: 'Discovery',
  AWAITING_HEARING: 'Awaiting hearing', JUDGMENT: 'Judgment',
  APPEAL: 'On appeal', SETTLED: 'Settled', DISMISSED: 'Dismissed',
  COLLECTIONS: 'Collections', ON_HOLD: 'On hold', CLOSED: 'Closed',
};

// Ordered roughly by how a matter progresses, so the dropdown reads as a path.
export const LEGAL_STATUSES: string[] = [
  'OPEN', 'PENDING_FILING', 'FILED', 'IN_LITIGATION', 'DISCOVERY',
  'AWAITING_HEARING', 'JUDGMENT', 'APPEAL', 'COLLECTIONS', 'ON_HOLD',
  'SETTLED', 'DISMISSED', 'CLOSED',
];

export const LEGAL_CLOSED_STATUSES = ['CLOSED', 'SETTLED', 'DISMISSED'];

export const LEGAL_EVENT_TYPES: string[] = [
  'FILING', 'SERVICE', 'HEARING', 'MOTION', 'DISCOVERY', 'MEDIATION',
  'JUDGMENT', 'APPEAL', 'SETTLEMENT', 'LOCKOUT', 'NOTICE', 'CORRESPONDENCE', 'OTHER',
];

export const LEGAL_EVENT_LABELS: Record<string, string> = {
  FILING: 'Filing', SERVICE: 'Service of process', HEARING: 'Hearing',
  MOTION: 'Motion', DISCOVERY: 'Discovery', MEDIATION: 'Mediation',
  JUDGMENT: 'Judgment', APPEAL: 'Appeal', SETTLEMENT: 'Settlement',
  LOCKOUT: 'Lockout / writ', NOTICE: 'Notice served', CORRESPONDENCE: 'Correspondence',
  OTHER: 'Other',
};

export const LEGAL_FEE_CATEGORIES: string[] = [
  'RETAINER', 'HOURLY', 'FLAT_FEE', 'FILING_FEE', 'SERVICE_FEE',
  'COURT_COST', 'EXPERT', 'TRANSCRIPT', 'SETTLEMENT', 'JUDGMENT_PAID', 'OTHER',
];

export const LEGAL_FEE_LABELS: Record<string, string> = {
  RETAINER: 'Retainer', HOURLY: 'Hourly billing', FLAT_FEE: 'Flat fee',
  FILING_FEE: 'Court filing fee', SERVICE_FEE: 'Process service',
  COURT_COST: 'Court costs', EXPERT: 'Expert / witness', TRANSCRIPT: 'Transcript',
  SETTLEMENT: 'Settlement paid', JUDGMENT_PAID: 'Judgment paid', OTHER: 'Other',
};

export const LEGAL_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export const LEGAL_DOC_CATEGORIES = ['LEGAL', 'CONTRACT', 'COURT_FILING', 'CORRESPONDENCE', 'IDENTITY', 'OTHER'];

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
  chargesExcludingFees?: number;
  penaltiesFees?: number;
  pastDueCarried?: number;
  notes?: string;
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

export interface StatementSummaryRow {
  id: string;
  statementDate: string;
  dueDate: string | null;
  amountDue: number | null;
  amountPaid: number | null;
  chargesExcludingFees: number | null;
  penaltiesFees: number | null;
  pastDueCarried: number | null;
  totalDueWithPastDue: number | null;
  notes?: string | null;
  utilityAccountId: string;
  providerName: string;
  category: UtilityCategory;
  propertyId: string;
  propertyLabel: string;
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
  INSURANCE: 'Insurance', HOA: 'HOA', TAXES: 'Taxes', LOAN: 'Loan', CREDIT_CARD: 'Credit Card', OTHER: 'Other',
};

export const CATEGORY_COLORS: Record<UtilityCategory, string> = {
  ELECTRIC: '#F5A623', GAS: '#5DCAA5', WATER: '#378ADD', SEWER: '#7F77DD',
  TRASH: '#888780', SOLAR: '#EF9F27', INTERNET: '#D4537E', PHONE: '#F0997B',
  INSURANCE: '#E24B4A', HOA: '#1D9E75', TAXES: '#534AB7', LOAN: '#4AA8E2', CREDIT_CARD: '#C9598A', OTHER: '#B4B2A9',
};

export const LOAN_TYPE_LABELS: Record<string, string> = {
  MORTGAGE: 'Mortgage', HELOC: 'HELOC', AUTO: 'Auto', PERSONAL: 'Personal',
  STUDENT: 'Student', INSTALLMENT_PLAN: 'Installment Plan',
  CREDIT_LINE: 'Credit Line', SELLER_FINANCING: 'Seller Financing',
  DSCR: 'DSCR', COMMERCIAL: 'Commercial', HARD_MONEY: 'Hard Money', OTHER: 'Other',
};

export const INSURANCE_TYPE_LABELS: Record<string, string> = {
  PROPERTY: 'Property', LIABILITY: 'Liability', FLOOD: 'Flood', UMBRELLA: 'Umbrella', OTHER: 'Other',
};

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  PRIMARY: 'Primary home', RENTAL: 'Rental', INVESTMENT: 'Investment', COMMERCIAL: 'Commercial',
  MIXED_USE: 'Mixed-use',
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
  AUTO_LOAN: 'Auto Loan', AUTO_INSURANCE: 'Auto Insurance',
  CREDIT_CARD: 'Credit Cards', MEDICAL: 'Medical', PHONE: 'Phone',
  STUDENT_LOAN: 'Student Loan', LIFE_INSURANCE: 'Life Insurance',
  SUBSCRIPTIONS: 'Subscriptions',
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
  watchForRentPayments?: boolean;
  watchForExpenses?: boolean;
  plaidAccountId?: string | null;
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

export interface BudgetUtilityRow {
  statementId: string;
  provider: string;
  category: string;
  property: string;
  propertyId: string;
  amountDue: number;
  amountPaid: number;
  dueDate: string | null;
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
  computedLikelihood: 'high' | 'medium' | 'low' | 'none';
  likelihood: 'high' | 'medium' | 'low' | 'none';
  isManualOverride: boolean;
  manualLikelihoodNote: string | null;
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
  utilities: {
    rows: BudgetUtilityRow[];
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

export interface BudgetForecastMonth {
  month: string;
  label: string;
  rentalIncome: number;
  mortgages: number;
  utilities: number;
  netCashFlow: number;
}

export interface BudgetForecast {
  months: BudgetForecastMonth[];
  baseline: {
    rentBaseline: number;
    mortgageBaseline: number;
    utilityBaseline: number;
    activeLeaseCount: number;
    activeLoanCount: number;
    utilityAccountsWithData: number;
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

// ─── TURNOVER ────────────────────────────────────────────
// Derived from the lease timeline of each unit — see backend/src/routes/turnover.ts.
export interface Tenancy {
  leaseId: string;
  tenants: string[];
  businessName: string | null;
  startDate: string;
  endDate: string | null;
  rentAmount: number;
  status: LeaseStatus;
  leaseType: LeaseType;
  isCurrent: boolean;
  months: number | null;
}

export interface Turnover {
  outgoingLeaseId: string;
  incomingLeaseId: string;
  outgoingTenants: string[];
  incomingTenants: string[];
  vacatedOn: string;
  reoccupiedOn: string;
  daysVacant: number;
  rentLost: number;
  previousRent: number;
  newRent: number;
  rentChange: number;
  rentChangePct: number | null;
}

export interface UnitTurnover {
  unitId: string;
  unitLabel: string;
  propertyId: string;
  propertyAddress: string;
  tenancies: Tenancy[];
  turnovers: Turnover[];
  currentVacancy: {
    vacatedOn: string;
    daysVacant: number;
    lostSoFar: number;
    lastRent: number;
    lastTenants: string[];
  } | null;
}

export interface TurnoverReport {
  summary: {
    turnovers: number;
    avgVacancyDays: number | null;
    longestVacancyDays: number | null;
    totalDaysVacant: number;
    totalRentLost: number;
    avgTenancyMonths: number | null;
    avgRentChange: number | null;
    currentlyVacant: number;
    ongoingRentLost: number;
    unitsTracked: number;
  };
  units: UnitTurnover[];
}
