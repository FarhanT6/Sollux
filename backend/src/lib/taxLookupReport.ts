/**
 * The pure half of a property-tax lookup (services/propertyTaxLookup.ts):
 * where it starts for a county, and the shape of what the agent reports,
 * typed and trimmed before anything is saved.
 */

/** Where to start, when Sollux knows the county's tax site. Keyed "ST:county" in lower case. */
const COUNTY_SITES: Record<string, string> = {
  'ca:san diego': 'https://www.sdttc.com/',
  'ca:imperial': 'https://treasurer-taxcollector.imperialcounty.org/',
  'ca:riverside': 'https://countytreasurer.org/',
  'ca:san bernardino': 'https://www.sbcountyatc.gov/',
  'fl:brevard': 'https://brevard.county-taxes.com/public',
};

export function startUrlFor(state: string | null | undefined, county: string | null | undefined, apn: string, city?: string | null): string {
  const st = String(state ?? '').trim().toLowerCase();
  const co = String(county ?? '').trim().toLowerCase().replace(/\s+county$/, '');
  const known = COUNTY_SITES[`${st}:${co}`];
  if (known) return known;
  // Most Florida tax collectors are on Grant Street's county-taxes.com.
  if (st === 'fl' && co) return `https://${co.replace(/[^a-z]/g, '')}.county-taxes.com/public`;
  // No county on file: the city places it.
  const q = `${co ? `${co} county` : city ? `${city} county` : ''} ${st.toUpperCase()} treasurer tax collector property tax search ${apn ? `parcel ${apn}` : 'by address'}`.replace(/\s+/g, ' ').trim();
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
}

export interface LookupYear {
  taxYear: string; annualTaxAmount?: number | null; status?: 'UNPAID' | 'PAID' | 'PARTIALLY_PAID' | 'DELINQUENT' | null;
  installment1Amount?: number | null; installment1Due?: string | null; installment1Delinquent?: string | null; installment1Paid?: string | null;
  installment2Amount?: number | null; installment2Due?: string | null; installment2Delinquent?: string | null; installment2Paid?: string | null;
  billNumber?: string | null; assessedValue?: number | null; landValue?: number | null; improvementValue?: number | null; marketValue?: number | null;
  exemptionsValue?: number | null; exemptionsNote?: string | null; baseYear?: string | null; taxRate?: number | null;
  specialAssessments?: { name: string; amount: number; phone?: string | null; cfd?: boolean }[] | null;
  penaltiesOwed?: number | null; balanceOwed?: number | null;
}
export interface LookupDefault {
  taxYear: string; status?: 'OPEN' | 'PLAN' | 'REDEEMED' | 'SOLD' | null; defaultNumber?: string | null; defaultDate?: string | null;
  taxAmount?: number | null; penalties?: number | null; costs?: number | null; amountToRedeem?: number | null; redeemGoodThrough?: string | null;
  powerToSellDate?: string | null; payPlan?: { started?: string | null; installment?: number | null; nextDue?: string | null; remaining?: number | null; balance?: number | null } | null;
  certificateNumber?: string | null; certificateHolder?: string | null; certificateRate?: number | null; certificateIssued?: string | null; redeemedOn?: string | null; notes?: string | null;
}
export interface LookupReport {
  found: boolean; sourceUrl?: string | null; taxingAuthority?: string | null; apn?: string | null;
  /** The parcel's situs address as the county prints it, and its county: how a parcel found by address is checked. */
  situsAddress?: string | null; county?: string | null;
  years?: LookupYear[]; defaults?: LookupDefault[]; notes?: string | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(/[$,]/g, ''))) ? Number(v.replace(/[$,]/g, '')) : null);
const day = (v: unknown) => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };

/** What the agent reported, typed and trimmed: anything malformed is left out rather than saved. */
export function cleanReport(r: any): LookupReport {
  const years: LookupYear[] = (Array.isArray(r?.years) ? r.years : []).filter((y: any) => str(y?.taxYear)).slice(0, 15).map((y: any) => ({
    taxYear: str(y.taxYear)!, annualTaxAmount: num(y.annualTaxAmount),
    status: ['UNPAID', 'PAID', 'PARTIALLY_PAID', 'DELINQUENT'].includes(y.status) ? y.status : null,
    installment1Amount: num(y.installment1Amount), installment1Due: day(y.installment1Due), installment1Delinquent: day(y.installment1Delinquent), installment1Paid: day(y.installment1Paid),
    installment2Amount: num(y.installment2Amount), installment2Due: day(y.installment2Due), installment2Delinquent: day(y.installment2Delinquent), installment2Paid: day(y.installment2Paid),
    billNumber: str(y.billNumber), assessedValue: num(y.assessedValue), landValue: num(y.landValue), improvementValue: num(y.improvementValue), marketValue: num(y.marketValue),
    exemptionsValue: num(y.exemptionsValue) != null ? Math.abs(num(y.exemptionsValue)!) : null, exemptionsNote: str(y.exemptionsNote), baseYear: str(y.baseYear), taxRate: num(y.taxRate),
    specialAssessments: Array.isArray(y.specialAssessments)
      ? y.specialAssessments.filter((a: any) => str(a?.name) && num(a?.amount) != null).slice(0, 60)
        .map((a: any) => ({ name: str(a.name)!, amount: num(a.amount)!, phone: str(a.phone), cfd: !!a.cfd || /mello|\bcfd\b|community facilities|\bcdd\b/i.test(String(a.name)) }))
      : null,
    penaltiesOwed: num(y.penaltiesOwed), balanceOwed: num(y.balanceOwed),
  }));
  const defaults: LookupDefault[] = (Array.isArray(r?.defaults) ? r.defaults : []).filter((d: any) => str(d?.taxYear)).slice(0, 20).map((d: any) => ({
    taxYear: str(d.taxYear)!, status: ['OPEN', 'PLAN', 'REDEEMED', 'SOLD'].includes(d.status) ? d.status : null,
    defaultNumber: str(d.defaultNumber), defaultDate: day(d.defaultDate), taxAmount: num(d.taxAmount), penalties: num(d.penalties), costs: num(d.costs),
    amountToRedeem: num(d.amountToRedeem), redeemGoodThrough: day(d.redeemGoodThrough), powerToSellDate: day(d.powerToSellDate),
    payPlan: d.payPlan && typeof d.payPlan === 'object'
      ? { started: day(d.payPlan.started), installment: num(d.payPlan.installment), nextDue: day(d.payPlan.nextDue), remaining: num(d.payPlan.remaining), balance: num(d.payPlan.balance) }
      : null,
    certificateNumber: str(d.certificateNumber), certificateHolder: str(d.certificateHolder), certificateRate: num(d.certificateRate), certificateIssued: day(d.certificateIssued),
    redeemedOn: day(d.redeemedOn), notes: str(d.notes),
  }));
  const sourceUrl = str(r?.sourceUrl);
  return { found: !!r?.found, sourceUrl: sourceUrl && /^https?:\/\//.test(sourceUrl) ? sourceUrl : null, taxingAuthority: str(r?.taxingAuthority), apn: str(r?.apn), situsAddress: str(r?.situsAddress), county: str(r?.county), years, defaults, notes: str(r?.notes) };
}


/**
 * A parcel found by address is the property's only when its situs address
 * carries the same street number and street name: "1200 Elm Grove Ln" and
 * "1200 ELM GROVE LANE" agree; "1204 Elm Grove Ln" does not.
 */
export function sameStreetAddress(ours: string, theirs: string | null | undefined): boolean {
  if (!theirs) return false;
  const norm = (a: string) => a.toUpperCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(ours), b = norm(theirs);
  const numA = a.match(/^\d+[A-Z]?/)?.[0], numB = b.match(/^\d+[A-Z]?/)?.[0];
  if (!numA || numA !== numB) return false;
  // The first word of the street name after the number.
  const word = (x: string) => x.replace(/^\d+[A-Z]?\s+/, '').replace(/^(N|S|E|W|NORTH|SOUTH|EAST|WEST)\s+/, '').split(' ')[0];
  return word(a) === word(b);
}
