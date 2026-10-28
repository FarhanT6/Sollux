/**
 * Look a parcel up on its county's own tax site, for any county and year:
 * the current bill's installments and delinquency dates, values, exemptions
 * and base year, special assessments (Mello-Roos), earlier years — paid or
 * not — and anything left unpaid: California defaults (default number,
 * redemption amount, plan of redemption), Florida tax certificates, liens.
 *
 * A browser agent does it, the same way the portal agent fetches bills
 * (scrapers/portalAgent.ts): it starts on the county's tax collector page
 * when Sollux knows it, else on a web search, searches by parcel number,
 * reads the pages and reports what they say. Read only: it never pays,
 * signs up or enters anything but the parcel number and address.
 *
 * What it reports is saved over the property's tax records — figures the
 * county did not show leave what is on file alone — with the page it came
 * from and when.
 */
import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { Prisma } from '@prisma/client';
import fs from 'fs';
import { db } from '../config/db';
import { describe } from '../scrapers/portalAgent';
import { refLocator } from '../scrapers/portalRecipe';
import { launchPortalContext } from '../scrapers/browser';
import { BaseScraperProvider } from '../scrapers/base';
import { connectorFor } from './connector';
import { meteredCreate, paramsFor, PRIMARY_MODEL } from '../ai/models';
import { withAiContext, costOf, checkBudget } from '../ai/meter';
import { startUrlFor, cleanReport, sameStreetAddress, type LookupReport } from '../lib/taxLookupReport';

export { startUrlFor, cleanReport };


const TOOLS: Anthropic.Tool[] = [
  { name: 'look', description: 'Describe the current page: URL, visible text and numbered interactive elements [n].', input_schema: { type: 'object', properties: {} } },
  { name: 'screenshot', description: 'A picture of the page, when the text is not enough (a table drawn as an image, a map).', input_schema: { type: 'object', properties: {} } },
  { name: 'click', description: 'Click element [n].', input_schema: { type: 'object', properties: { ref: { type: 'number' } }, required: ['ref'] } },
  { name: 'type', description: 'Type text into field [n] (the parcel number, the street address). submit: press Enter afterwards.', input_schema: { type: 'object', properties: { ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] } },
  { name: 'select', description: 'Choose an option in dropdown [n] by its visible label.', input_schema: { type: 'object', properties: { ref: { type: 'number' }, label: { type: 'string' } }, required: ['ref', 'label'] } },
  { name: 'press', description: 'Press a key (Enter, Tab, Escape).', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'goto', description: 'Open a URL (https only).', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'back', description: 'Go back one page.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'report',
    description: 'Finish with what the county\'s pages showed. Dates YYYY-MM-DD, amounts as numbers. Leave out anything not shown; never guess. found false when the parcel could not be found or the site would not show it (say why in notes).',
    input_schema: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        sourceUrl: { type: 'string', description: 'The page with the parcel\'s current bill.' },
        taxingAuthority: { type: 'string' },
        apn: { type: 'string', description: 'The parcel number as the county prints it.' },
        situsAddress: { type: 'string', description: "The parcel's property (situs) address as the county shows it." },
        county: { type: 'string', description: 'The county the parcel is in.' },
        years: {
          type: 'array', description: 'Every tax year shown — the current one and earlier ones, paid or not.',
          items: {
            type: 'object',
            properties: {
              taxYear: { type: 'string', description: '"2026-27" for a fiscal year, "2026" for a calendar year.' },
              annualTaxAmount: { type: 'number' }, status: { type: 'string', enum: ['UNPAID', 'PAID', 'PARTIALLY_PAID', 'DELINQUENT'] },
              installment1Amount: { type: 'number' }, installment1Due: { type: 'string' }, installment1Delinquent: { type: 'string' }, installment1Paid: { type: 'string' },
              installment2Amount: { type: 'number' }, installment2Due: { type: 'string' }, installment2Delinquent: { type: 'string' }, installment2Paid: { type: 'string' },
              billNumber: { type: 'string' }, assessedValue: { type: 'number', description: 'Net taxable value.' }, landValue: { type: 'number' }, improvementValue: { type: 'number' },
              marketValue: { type: 'number' }, exemptionsValue: { type: 'number' }, exemptionsNote: { type: 'string' }, baseYear: { type: 'string' }, taxRate: { type: 'number', description: 'Percent.' },
              specialAssessments: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' }, phone: { type: 'string' }, cfd: { type: 'boolean' } }, required: ['name', 'amount'] } },
              penaltiesOwed: { type: 'number' }, balanceOwed: { type: 'number' },
            },
            required: ['taxYear'],
          },
        },
        defaults: {
          type: 'array', description: 'Years left unpaid past their deadline: a California tax-defaulted year (its default number, e.g. DEF230000268, and default date), a Florida tax certificate, a lien. Include redeemed ones if shown.',
          items: {
            type: 'object',
            properties: {
              taxYear: { type: 'string' }, status: { type: 'string', enum: ['OPEN', 'PLAN', 'REDEEMED', 'SOLD'] }, defaultNumber: { type: 'string' }, defaultDate: { type: 'string' },
              taxAmount: { type: 'number' }, penalties: { type: 'number' }, costs: { type: 'number' }, amountToRedeem: { type: 'number' }, redeemGoodThrough: { type: 'string' },
              powerToSellDate: { type: 'string', description: 'When the county may sell, or a deed may be applied for, if the page states it.' },
              payPlan: { type: 'object', properties: { started: { type: 'string' }, installment: { type: 'number' }, nextDue: { type: 'string' }, remaining: { type: 'number' }, balance: { type: 'number' } } },
              certificateNumber: { type: 'string' }, certificateHolder: { type: 'string' }, certificateRate: { type: 'number' }, certificateIssued: { type: 'string' }, redeemedOn: { type: 'string' }, notes: { type: 'string' },
            },
            required: ['taxYear'],
          },
        },
        notes: { type: 'string' },
      },
      required: ['found'],
    },
  },
];

export interface LookupRun { ok: boolean; report: LookupReport | null; error?: string; steps: number; costUsd: number; candidates?: ParcelCandidate[]; saved?: { years: number; defaults: number } }
export interface ParcelCandidate { apn: string; situsAddress: string | null; owner: string | null; note: string | null }

type Prop = { id: string; userId: string; address: string; city: string; state: string; zip: string; county: string | null; apn: string | null; ownerEntity: string | null };

// Finding the parcel and reading its taxes are two runs, each with its own
// time: one run doing both ran out of time on the second half.
const FIND = { ms: 4 * 60_000, steps: 30, usd: 0.45 };
const READ = { ms: 8 * 60_000, steps: 50, usd: 1.2 };

const PARCEL_TOOL: Anthropic.Tool = {
  name: 'report_parcel',
  description: "Finish with the parcel you found. found false when none could be found (say why in notes). When several parcels could be this property (units, adjacent lots, the owner's other land), list each in candidates.",
  input_schema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      apn: { type: 'string', description: 'The parcel number, as the county prints it.' },
      situsAddress: { type: 'string', description: "The parcel's situs (property) address as the county shows it." },
      county: { type: 'string' },
      candidates: { type: 'array', items: { type: 'object', properties: { apn: { type: 'string' }, situsAddress: { type: 'string' }, owner: { type: 'string' }, note: { type: 'string', description: 'acreage, use code, legal description' } }, required: ['apn'] } },
      notes: { type: 'string' },
    },
    required: ['found'],
  },
};

/**
 * The street address the property's own bills print most often (utility,
 * insurance and HOA statements carry a service address), when the property
 * itself is recorded under a name. Only the street part of an address in
 * the property's city.
 */
async function addressFromBills(propertyId: string): Promise<string | null> {
  const rows = await db.statement.findMany({
    where: { utilityAccount: { propertyId } }, orderBy: { statementDate: 'desc' }, take: 60, select: { rawDataJson: true },
  });
  const count = new Map<string, number>();
  for (const r of rows) {
    const a = String((r.rawDataJson as any)?.serviceAddress ?? '').trim();
    // "645 S El Cerrito Ave, Brawley CA 92227" → "645 S El Cerrito Ave"
    const street = a.split(/,|\n/)[0].trim();
    if (!hasStreetNumber(street) || street.length > 80) continue;
    const key = street.toUpperCase().replace(/\s+/g, ' ');
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const best = [...count].sort((x, y) => y[1] - x[1])[0];
  return best ? best[0] : null;
}

/** A street address has a house number; "Titusville" or a lot's nickname does not. */
const hasStreetNumber = (a: string) => /^\s*\d+[A-Za-z]?\s+\S/.test(a);

/**
 * Runs a lookup for one property (spend counted against its owner): first
 * the parcel number when none is on file, then its taxes by that number.
 */
export async function lookupPropertyTax(propertyId: string, onProgress?: (t: string) => void, cancelled: () => Promise<boolean> = async () => false): Promise<LookupRun> {
  const p = await db.property.findUnique({ where: { id: propertyId }, select: { id: true, userId: true, address: true, city: true, state: true, zip: true, county: true, apn: true, ownerEntity: true } });
  if (!p) return { ok: false, report: null, error: 'Property not found', steps: 0, costUsd: 0 };
  return withAiContext({ userId: p.userId }, async () => {
    if (!process.env.ANTHROPIC_API_KEY) return { ok: false, report: null, error: 'AI is not configured.', steps: 0, costUsd: 0 };
    // Before any browser opens: a run the budget would stop at its first step
    // only flashed tabs open and shut in the owner's Chrome.
    try { await checkBudget('tax-lookup'); } catch (err) { return { ok: false, report: null, error: err instanceof Error ? err.message : String(err), steps: 0, costUsd: 0 }; }

    let steps = 0, costUsd = 0;
    if (!p.apn) {
      const found = await findParcel(p, t => onProgress?.(`Finding the parcel · ${t}`), cancelled);
      steps += found.steps; costUsd += found.costUsd;
      if (!found.ok) return { ...found, steps, costUsd };
      p.apn = found.report!.apn!;
      await db.property.update({ where: { id: p.id }, data: { apn: p.apn, ...(found.report!.county && !p.county ? { county: found.report!.county.replace(/\s+county$/i, '') } : {}) } });
      if (found.report!.county && !p.county) p.county = found.report!.county.replace(/\s+county$/i, '');
    }
    if (await cancelled()) return { ok: false, report: null, error: 'Cancelled.', steps, costUsd };
    const run = await readTaxes(p, t => onProgress?.(`Reading the tax bill · ${t}`), cancelled);
    run.steps += steps; run.costUsd += costUsd;
    if (run.report?.found) run.saved = await saveReport(p.id, { ...run.report, apn: run.report.apn ?? p.apn });
    // Read, but nothing to keep: say so rather than "looked up" with nothing on file.
    if (run.ok && !run.saved?.years && !run.saved?.defaults) {
      return { ...run, ok: false, error: `The county site was read for parcel ${p.apn}, but it showed no tax amounts to save.${run.report?.notes ? ` ${run.report.notes}` : ''} Upload the tax bill instead (+ Year → upload), or try again later.` };
    }
    return run;
  });
}

/**
 * Step one: the parcel number from the address (or, for land with no
 * street address, the owner's name on the title). A parcel is taken only
 * when its situs address has this property's number and street; several
 * possible parcels go back to the owner to choose.
 */
export async function findParcel(prop: Prop, say: (t: string) => void, cancelled: () => Promise<boolean> = async () => false): Promise<LookupRun> {
  const run: LookupRun = { ok: false, report: null, steps: 0, costUsd: 0 };
  // A property named rather than addressed ("De Anza", "FL Corner Lot"): its
  // bills print where the service is — the street address to search by.
  let p = prop;
  if (!hasStreetNumber(p.address)) {
    const billed = await addressFromBills(p.id);
    if (billed) { say(`using ${billed} from the property's bills`); p = { ...p, address: billed }; }
  }
  const street = hasStreetNumber(p.address);
  if (!street && !p.ownerEntity) {
    run.error = `"${prop.address}" is a name, not a street address, and the property's bills print none. Add its street address (edit the property), its parcel number (Parcel), or the owner name on the title (Owner entity) and Sollux will search by that.`;
    return run;
  }
  // A county's public address → parcel service first: one request, no browser.
  if (street) {
    const direct = await parcelFromCountyService(p).catch(err => { console.warn('[TaxLookup] county parcel service:', err instanceof Error ? err.message : err); return null; });
    if (direct?.length === 1) {
      say(`found parcel ${direct[0].apn} in the county's address records`);
      return { ...run, ok: true, report: { found: true, apn: direct[0].apn, situsAddress: direct[0].situsAddress, county: p.county } };
    }
    if (direct && direct.length > 1) { run.candidates = direct; run.error = `Found ${direct.length} possible parcels at this address — pick the right one on the property's Parcel panel.`; return run; }
  }
  const by = street
    ? `the street address ${p.address}, ${p.city}, ${p.state} ${p.zip}`
    : `the owner name "${p.ownerEntity}" (the property is land with no street address, in or near ${p.city}, ${p.state} ${p.zip}; nickname "${p.address}")`;
  const system = `You operate a web browser to find ONE thing: the assessor's parcel number (APN / parcel ID / folio / account number) of a property, by ${by}.${p.county ? ` County: ${p.county}.` : ' The county is not on file: work it out from the city and ZIP, and report it.'}
Use the county assessor's or property appraiser's parcel / address search, or the county's GIS parcel viewer (search a web search engine for "${p.county ? `${p.county} County` : p.city} ${p.state} assessor parcel search" when you do not know it). Do not look at taxes — that is a separate step.
${street ? 'Take the parcel whose situs address has the same house number and street as the property. If several do (units, condos, adjacent lots), list them all in candidates.' : 'List every parcel the owner holds in that area in candidates, with its situs address, acreage or legal description; mark the most likely one as apn only if exactly one fits (vacant land, the right city).'}
Rules: read only; never sign in, pay or register; ignore paid property-record sites. If a captcha blocks you, try the county's other official search once, then report found false and say why.
Call report_parcel as soon as you have it.`;
  const out = await browse(p.userId, startParcelUrl(p, street), system, PARCEL_TOOL, FIND, say, cancelled);
  run.steps = out.steps; run.costUsd = out.costUsd;
  if (!out.input) { run.error = out.error ?? 'The parcel search did not finish.'; return run; }
  const i = out.input as any;
  const candidates: ParcelCandidate[] = Array.isArray(i.candidates)
    ? i.candidates.filter((c: any) => c?.apn).slice(0, 12).map((c: any) => ({ apn: String(c.apn).slice(0, 60), situsAddress: c.situsAddress ? String(c.situsAddress).slice(0, 200) : null, owner: c.owner ? String(c.owner).slice(0, 120) : null, note: c.note ? String(c.note).slice(0, 200) : null }))
    : [];
  const apn = i.found && i.apn ? String(i.apn).slice(0, 60) : null;
  const situs = i.situsAddress ? String(i.situsAddress) : null;
  // By address: only an exact street match is taken.
  if (apn && (!street || sameStreetAddress(p.address, situs))) {
    run.ok = true;
    run.report = { found: true, apn, situsAddress: situs, county: i.county ? String(i.county) : null };
    return run;
  }
  run.candidates = candidates.length ? candidates : apn ? [{ apn, situsAddress: situs, owner: null, note: null }] : undefined;
  run.error = run.candidates?.length
    ? `Found ${run.candidates.length === 1 ? 'a parcel' : `${run.candidates.length} possible parcels`} — pick the right one on the property's Parcel panel.`
    : (i.notes ? String(i.notes).slice(0, 300) : 'No parcel was found for this property.');
  return run;
}

/**
 * San Diego County's public address points (SanGIS ADDRAPN: every situs
 * address with its APN). Field names as the layer documents them —
 * ADDRNMBR (house number), ADDRNAME (street name), APN — read defensively;
 * any surprise returns null and the browser search takes over. Other
 * counties: null.
 */
const SANDIEGO_ADDRAPN = 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/sdep_warehouse/ADDRAPN/MapServer/0/query';
async function parcelFromCountyService(p: Prop): Promise<ParcelCandidate[] | null> {
  const sdCities = /^(san diego|oceanside|escondido|carlsbad|vista|san marcos|chula vista|el cajon|la mesa|santee|poway|encinitas|national city|imperial beach|lemon grove|coronado|del mar|solana beach|fallbrook|ramona|valley center|alpine|lakeside|spring valley|bonita|jamul|julian|borrego springs)$/i;
  const inSanDiego = String(p.state).toUpperCase() === 'CA' && (/^san diego$/i.test(String(p.county ?? '')) || sdCities.test(p.city.trim()));
  if (!inSanDiego) return null;
  const m = p.address.toUpperCase().match(/^\s*(\d+)\s+(?:(N|S|E|W)\.?\s+)?([A-Z0-9' ]+?)(?:\s+(ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|LN|LANE|WAY|CT|COURT|PL|PLACE|BLVD|BOULEVARD|CIR|CIRCLE|TER|TERRACE|PKWY|HWY|TRL|PT|LOOP|ROW|GLN|SQ))?\.?(?:\s+(?:#|APT|UNIT|STE)\s*\S+)?\s*$/);
  if (!m) return null;
  const [, num, , name] = m;
  const where = `ADDRNMBR=${Number(num)} AND UPPER(ADDRNAME) LIKE '${name.trim().replace(/'/g, "''")}%'`;
  const url = `${SANDIEGO_ADDRAPN}?where=${encodeURIComponent(where)}&outFields=*&returnGeometry=false&f=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const j = await res.json() as { features?: { attributes: Record<string, unknown> }[]; error?: unknown };
  if (j.error || !Array.isArray(j.features)) return null;
  const zip = p.zip.slice(0, 5);
  const byApn = new Map<string, ParcelCandidate>();
  for (const f of j.features) {
    const a = f.attributes ?? {};
    const apn = String(a.APN ?? a.apn ?? '').trim();
    if (!/^\d{8,10}$/.test(apn)) continue;
    // A ZIP on the point that is not the property's is another street of that name.
    const z = String(a.ADDRZIP ?? a.ZIP ?? a.ZIPCODE ?? '').slice(0, 5);
    if (z && zip && z !== zip) continue;
    const situs = [a.ADDRNMBR, a.ADDRPDIR, a.ADDRNAME, a.ADDRSFX, a.COMMUNITY ?? a.ADDRCITY ?? ''].filter(Boolean).join(' ');
    // Printed as the county does: 123-456-78-00.
    const pretty = apn.length === 10 ? `${apn.slice(0, 3)}-${apn.slice(3, 6)}-${apn.slice(6, 8)}-${apn.slice(8)}` : apn;
    if (!byApn.has(pretty)) byApn.set(pretty, { apn: pretty, situsAddress: situs || null, owner: null, note: null });
  }
  return byApn.size ? [...byApn.values()] : null;
}

/** Where the parcel search starts: the county's assessor search when Sollux knows it, else a web search. */
function startParcelUrl(p: Prop, street: boolean): string {
  const place = p.county ? `${p.county} County` : `${p.city}`;
  const q = `${place} ${p.state} assessor parcel search ${street ? 'by address' : 'by owner'}`;
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
}

/** Step two: the taxes of a known parcel. */
async function readTaxes(p: Prop, say: (t: string) => void, cancelled: () => Promise<boolean>): Promise<LookupRun> {
  const run: LookupRun = { ok: false, report: null, steps: 0, costUsd: 0 };
  const system = `You operate a web browser to look up a property's taxes on its county's official tax website, for the property's owner.
Property: ${p.address}, ${p.city}, ${p.state} ${p.zip}${p.county ? ` — ${p.county} County` : ''}. Parcel number (APN / parcel ID / folio / account): ${p.apn}. Search the tax collector's site BY THIS PARCEL NUMBER.
Goal: find the parcel on the county treasurer-tax collector's (or tax collector's) own site — or the vendor site it links to for its tax search (Grant Street / county-taxes.com, MPTS, publicaccessnow, Tyler and the like) — and read:
1. the current tax year's bill: each installment's amount, due date, the date it becomes delinquent, whether and when it was paid, penalties and balance owed, the bill number;
2. the values on the roll: land, improvements, market (just) value, exemptions and which, net taxable value, the base year if shown, the tax rate;
3. every direct charge and special assessment on the bill (Mello-Roos / CFD, CDD, lighting, vector control …) with its amount and phone number if shown;
4. earlier years the site lists — paid or not;
5. anything left unpaid: on California sites the "defaulted" / "prior year" / "redemption" tab (default number like DEF230000268, default date, amount to redeem and the date it is good through, any five-year installment plan of redemption, the power-to-sell date if shown); on Florida sites the tax certificates (number, holder, interest rate, issue date, redemption amount, any tax deed application).
Work in this order and report early rather than late: the current bill first, then defaulted / prior years, then values. Rules: read only. Never pay, never start a payment or checkout, never enroll, never sign in, never enter anything but the parcel number. Prefer official county pages and the vendors they link to; ignore paid aggregators and ads. If a captcha blocks you, try the county's other official search once, then report found false and say why.
When done, call report once with the parcel number and everything the pages showed — never estimate a figure the page did not show.`;
  const out = await browse(p.userId, startUrlFor(p.state, p.county, p.apn ?? '', p.city), system, TOOLS.find(t => t.name === 'report')!, READ, say, cancelled);
  run.steps = out.steps; run.costUsd = out.costUsd;
  if (!out.input) { run.error = out.error ?? 'The tax search did not finish.'; return run; }
  run.report = cleanReport(out.input);
  if (!run.report.sourceUrl) run.report.sourceUrl = out.url ?? null;
  run.ok = run.report.found;
  if (!run.ok) run.error = run.report.notes || 'The county site did not show the parcel.';
  return run;
}

/**
 * One browsing run: Claude drives a browser — the owner's Chrome when their
 * connector is online (county sites that refuse cloud servers let it in),
 * else Sollux's — until it calls the finishing tool. At the step, time or
 * cost limit it is made to finish with what it has found, rather than the
 * run failing with nothing.
 */
async function browse(userId: string, start: string, system: string, finishTool: Anthropic.Tool, limits: { ms: number; steps: number; usd: number }, say: (t: string) => void, cancelled: () => Promise<boolean> = async () => false): Promise<{ input: unknown | null; error?: string; steps: number; costUsd: number; url?: string }> {
  let steps = 0, costUsd = 0;
  let remote: Browser | null = null;
  let ctx: BrowserContext;
  const connector = await connectorFor(userId).catch(() => null);
  if (connector) remote = await chromium.connectOverCDP(connector.wsUrl, { timeout: 30_000 }).catch(() => null);
  if (remote) ctx = remote.contexts()[0] ?? await remote.newContext({ viewport: { width: 1366, height: 900 } });
  else {
    const dir = BaseScraperProvider.profileDir(`taxlookup-${userId}`);
    await fs.promises.mkdir(dir, { recursive: true });
    ctx = await launchPortalContext(dir);
    await ctx.route('**/*', r => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue())).catch(() => {});
  }
  let page: Page = remote ? await ctx.newPage() : ctx.pages()[0] ?? await ctx.newPage();
  const opened: Page[] = [page];
  // Only the tabs this run opened (its page's pop-ups, and theirs): in the
  // owner's Chrome other tabs are not this run's to follow or close.
  const track = (pg: Page) => pg.on('popup', np => { opened.push(np); track(np); });
  track(page);
  const close = async () => {
    if (remote) { for (const t of opened) await t.close().catch(() => {}); await remote.close().catch(() => {}); }
    else await ctx.close().catch(() => {});
  };
  const after = async (what: string) => {
    await page.waitForTimeout(500);
    const newest = opened.filter(t => !t.isClosed()).pop();
    if (newest && newest !== page) { page = newest; what += ' (it opened in a new tab; you are now on it)'; }
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(900);
    return `${what}\n\n${await describe(page, [])}`;
  };
  const tools = [...TOOLS.filter(t => t.name !== 'report'), finishTool];
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const deadline = Date.now() + limits.ms;
  try {
    say(`opening ${new URL(start).hostname}`);
    await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `The browser is open.\n\n${await describe(page, [])}` }];
    for (;;) {
      // Cancelled by the owner: stop at once (the tabs close below).
      if (await cancelled()) return { input: null, error: 'Cancelled.', steps, costUsd };
      // Out of time, steps or money: finish now with what has been found.
      const last = Date.now() >= deadline || steps >= limits.steps || costUsd >= limits.usd;
      if (last) messages.push({ role: 'user', content: `Time is up. Call ${finishTool.name} now with everything you have found so far (found false if you found nothing).` });
      const res = await meteredCreate(client, 'tax-lookup', {
        ...paramsFor(PRIMARY_MODEL, { maxTokens: 3000, system, messages, cache: true }),
        tools: last ? [finishTool] : tools,
        ...(last ? { tool_choice: { type: 'tool', name: finishTool.name } } : {}),
      } as Anthropic.MessageCreateParamsNonStreaming);
      steps++;
      costUsd += costOf(PRIMARY_MODEL, res.usage);
      messages.push({ role: 'assistant', content: res.content });
      const uses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
      const fin = uses.find(u => u.name === finishTool.name);
      if (fin) return { input: fin.input, steps, costUsd, url: page.url() };
      if (last) return { input: null, error: 'The search ran out of time before it found anything.', steps, costUsd };
      if (!uses.length) return { input: null, error: 'The search stopped without reporting.', steps, costUsd };
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const i = u.input as any;
        let content: Anthropic.ToolResultBlockParam['content'] = '';
        try {
          switch (u.name) {
            case 'look': content = await describe(page, []); break;
            case 'screenshot': content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: (await page.screenshot({ type: 'png', scale: 'css' })).toString('base64') } }]; break;
            case 'click': say('reading the county site'); await refLocator(page, Number(i.ref)).click({ timeout: 10000 }); content = await after('Clicked.'); break;
            case 'type': {
              await refLocator(page, Number(i.ref)).fill(String(i.text ?? ''));
              if (i.submit) await refLocator(page, Number(i.ref)).press('Enter');
              content = await after(i.submit ? 'Typed and submitted.' : 'Typed.');
              break;
            }
            case 'select': await refLocator(page, Number(i.ref)).selectOption({ label: String(i.label) }); content = await after('Selected.'); break;
            case 'press': await page.keyboard.press(String(i.key)); content = await after(`Pressed ${i.key}.`); break;
            case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}); content = await after('Back.'); break;
            case 'goto': {
              const url = new URL(String(i.url), page.url());
              if (url.protocol !== 'https:') { content = 'Refused: https only.'; break; }
              say(`opening ${url.hostname}`);
              await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
              content = await after('Opened.');
              break;
            }
            default: content = `Unknown tool ${u.name}`;
          }
        } catch (err) {
          content = `That did not work: ${err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : String(err)}\n\n${await describe(page, []).catch(() => '')}`;
        }
        results.push({ type: 'tool_result', tool_use_id: u.id, content });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (err) {
    return { input: null, error: err instanceof Error ? err.message.split('\n')[0] : String(err), steps, costUsd };
  } finally {
    await close();
  }
}

/** "2026-2027", "2026-27" and "2026/27" are one year: matched by the years they name. */
const sameYear = (a: string, b: string) => {
  const ys = (s: string) => (s.match(/(19|20)\d{2}/g) ?? []).map(Number);
  const [a1] = ys(a), [b1] = ys(b);
  return a1 != null && a1 === b1;
};
const at = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00Z`) : undefined);
/** Only what the county showed: a null leaves the field as it was. */
function present<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

export async function saveReport(propertyId: string, r: LookupReport): Promise<{ years: number; defaults: number }> {
  const now = new Date();
  const prop = await db.property.findUnique({ where: { id: propertyId }, select: { apn: true, county: true, state: true } });
  // The parcel number (and county) the county site showed fill what is missing.
  const fill = { ...(r.apn && !prop?.apn ? { apn: r.apn } : {}), ...(r.county && !prop?.county ? { county: r.county.replace(/\s+county$/i, '') } : {}) };
  if (Object.keys(fill).length) await db.property.update({ where: { id: propertyId }, data: fill });
  const existing = await db.taxAssessment.findMany({ where: { propertyId }, select: { id: true, taxYear: true } });
  let years = 0;
  for (const y of r.years ?? []) {
    // The year's total: as shown, or both installments' sum; one installment alone is not the year.
    const total = y.annualTaxAmount ?? (y.installment1Amount != null && y.installment2Amount != null ? Number((y.installment1Amount + y.installment2Amount).toFixed(2)) : null);
    // California's two secured installments are equal halves: one shown is half
    // the year. Used only for a year not yet on file — never over a real total.
    const one = y.installment1Amount ?? y.installment2Amount;
    const estimate = total == null && one != null && prop?.state === 'CA' ? Number((one * 2).toFixed(2)) : null;
    const data = present({
      annualTaxAmount: total, status: y.status ?? undefined,
      installment1Amount: y.installment1Amount, installment1Due: at(y.installment1Due), installment1Delinquent: at(y.installment1Delinquent), installment1Paid: at(y.installment1Paid),
      installment2Amount: y.installment2Amount, installment2Due: at(y.installment2Due), installment2Delinquent: at(y.installment2Delinquent), installment2Paid: at(y.installment2Paid),
      billNumber: y.billNumber, assessedValue: y.assessedValue, landValue: y.landValue, improvementValue: y.improvementValue, marketValue: y.marketValue,
      exemptionsValue: y.exemptionsValue, exemptionsNote: y.exemptionsNote, baseYear: y.baseYear, taxRate: y.taxRate,
      specialAssessmentsJson: y.specialAssessments?.length ? (y.specialAssessments as unknown as Prisma.InputJsonValue) : undefined,
      penaltiesOwed: y.penaltiesOwed, balanceOwed: y.balanceOwed, apn: r.apn, taxingAuthority: r.taxingAuthority,
      sourceUrl: r.sourceUrl, lookedUpAt: now,
    });
    const match = existing.find(e => sameYear(e.taxYear, y.taxYear));
    if (match) { await db.taxAssessment.update({ where: { id: match.id }, data: data as any }); years++; }
    else if ((total ?? estimate) != null) {
      const note = total == null ? 'Annual total taken as twice the installment shown (California installments are equal halves).' : undefined;
      const created = await db.taxAssessment.create({ data: { propertyId, taxYear: y.taxYear, ...(data as any), annualTaxAmount: (total ?? estimate)!, ...(note ? { notes: note } : {}) } });
      existing.push({ id: created.id, taxYear: created.taxYear });
      years++;
    }
  }
  const knownDefaults = await db.taxDefault.findMany({ where: { propertyId }, select: { id: true, taxYear: true } });
  let defaults = 0;
  for (const d of r.defaults ?? []) {
    const data = present({
      status: d.status ?? undefined, defaultNumber: d.defaultNumber, defaultDate: at(d.defaultDate), taxAmount: d.taxAmount, penalties: d.penalties, costs: d.costs,
      amountToRedeem: d.amountToRedeem, redeemGoodThrough: at(d.redeemGoodThrough), powerToSellDate: at(d.powerToSellDate),
      payPlanJson: d.payPlan && Object.values(d.payPlan).some(v => v != null) ? (d.payPlan as Prisma.InputJsonValue) : undefined,
      certificateNumber: d.certificateNumber, certificateHolder: d.certificateHolder, certificateRate: d.certificateRate, certificateIssued: at(d.certificateIssued),
      redeemedOn: at(d.redeemedOn), notes: d.notes, sourceUrl: r.sourceUrl, lookedUpAt: now,
    });
    const match = knownDefaults.find(k => sameYear(k.taxYear, d.taxYear));
    if (match) await db.taxDefault.update({ where: { id: match.id }, data: data as any });
    else { const c = await db.taxDefault.create({ data: { propertyId, taxYear: d.taxYear, ...(data as any) } }); knownDefaults.push({ id: c.id, taxYear: c.taxYear }); }
    defaults++;
  }
  return { years, defaults };
}
