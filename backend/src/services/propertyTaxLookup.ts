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
import { withAiContext, costOf } from '../ai/meter';
import { startUrlFor, cleanReport, sameStreetAddress, type LookupReport } from '../lib/taxLookupReport';

export { startUrlFor, cleanReport };

const RUN_MS = 6 * 60_000;
const MAX_STEPS = 45;
const MAX_USD = 0.9;

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

export interface LookupRun { ok: boolean; report: LookupReport | null; error?: string; steps: number; costUsd: number }

/** Runs a lookup for one property (spend counted against its owner) and saves what it found. */
export async function lookupPropertyTax(propertyId: string, onProgress?: (t: string) => void): Promise<LookupRun> {
  const p = await db.property.findUnique({ where: { id: propertyId }, select: { id: true, userId: true, address: true, city: true, state: true, zip: true, county: true, apn: true } });
  if (!p) return { ok: false, report: null, error: 'Property not found', steps: 0, costUsd: 0 };
  return withAiContext({ userId: p.userId }, async () => {
    const run = await runLookup(p, onProgress);
    // A parcel found by address is saved only when its address is this
    // property's: the wrong parcel's taxes must never land here.
    if (run.report?.found && !p.apn && !sameStreetAddress(p.address, run.report.situsAddress)) {
      run.ok = false;
      run.error = `Found parcel ${run.report.apn ?? '?'} at "${run.report.situsAddress ?? 'no address shown'}", which does not match ${p.address}. Nothing was saved — check the address, or add the parcel number.`;
      return run;
    }
    if (run.report?.found) await saveReport(p.id, run.report);
    return run;
  });
}

async function runLookup(p: { id: string; userId: string; address: string; city: string; state: string; zip: string; county: string | null; apn: string | null }, onProgress?: (t: string) => void): Promise<LookupRun> {
  const say = (t: string) => { try { onProgress?.(t); } catch { /* status only */ } };
  const run: LookupRun = { ok: false, report: null, steps: 0, costUsd: 0 };
  if (!p.apn && !p.address) { run.error = 'Add the property address or its parcel number (APN) first.'; return run; }
  if (!process.env.ANTHROPIC_API_KEY) { run.error = 'AI is not configured.'; return run; }
  const start = startUrlFor(p.state, p.county, p.apn ?? '', p.city);

  // The owner's own Chrome when its connector is online (county sites that
  // refuse cloud servers let it in), else Sollux's browser.
  let remote: Browser | null = null;
  let ctx: BrowserContext;
  const connector = await connectorFor(p.userId).catch(() => null);
  if (connector) {
    remote = await chromium.connectOverCDP(connector.wsUrl, { timeout: 30_000 }).catch(() => null);
  }
  if (remote) ctx = remote.contexts()[0] ?? await remote.newContext({ viewport: { width: 1366, height: 900 } });
  else {
    const dir = BaseScraperProvider.profileDir(`taxlookup-${p.userId}`);
    await fs.promises.mkdir(dir, { recursive: true });
    ctx = await launchPortalContext(dir);
    await ctx.route('**/*', r => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue())).catch(() => {});
  }
  let page: Page = remote ? await ctx.newPage() : ctx.pages()[0] ?? await ctx.newPage();
  const opened: Page[] = [page];
  ctx.on('page', np => { opened.push(np); });
  const close = async () => {
    if (remote) { for (const t of opened) await t.close().catch(() => {}); await remote.close().catch(() => {}); }
    else await ctx.close().catch(() => {});
  };

  const after = async (what: string) => {
    await page.waitForTimeout(500);
    // A result opened in a new tab: carry on there.
    const newest = opened.filter(t => !t.isClosed()).pop();
    if (newest && newest !== page) { page = newest; what += ' (it opened in a new tab; you are now on it)'; }
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(900);
    return `${what}\n\n${await describe(page, [])}`;
  };

  const system = `You operate a web browser to look up a property's taxes on its county's official tax website, for the property's owner.
Property: ${p.address}, ${p.city}, ${p.state} ${p.zip}${p.county ? ` — ${p.county} County` : ''}. Parcel number (APN / parcel ID / folio / account): ${p.apn ?? 'NOT KNOWN — find it first by the street address: the county assessor\'s or tax collector\'s address / situs search, or the county parcel map. Pick the parcel whose situs address matches this one exactly (number and street); if several match (units, adjacent lots), take the exact match and name the others in notes; if none matches exactly, report found false'}.${p.county ? '' : ' The county is not on file: work it out from the city and ZIP, and report it.'}
Goal: find the parcel on the county treasurer-tax collector's (or tax collector's) own site — or the vendor site it links to for its tax search (Grant Street / county-taxes.com, MPTS, publicaccessnow, Tyler and the like) — and read:
1. the current tax year's bill: each installment's amount, due date, the date it becomes delinquent, whether and when it was paid, penalties and balance owed, the bill number;
2. the values on the roll: land, improvements, market (just) value, exemptions and which, net taxable value, the base year if shown (California assessor pages show it), the tax rate;
3. every direct charge and special assessment on the bill (Mello-Roos / CFD, CDD, lighting, vector control …) with its amount and phone number if shown;
4. earlier years the site lists — paid or not;
5. anything left unpaid: on California sites the "defaulted" / "prior year" / "redemption" tab (default number like DEF230000268, default date, amount to redeem and the date it is good through, any five-year installment plan of redemption and its payments, the power-to-sell date if shown); on Florida sites the tax certificates (number, holder, interest rate, issue date, redemption amount, any tax deed application).
Open each tab or link the parcel's page offers for these (Current bill, Prior years, Delinquent / Defaulted taxes, Pay plan, Assessment / Values, Bill detail / Direct charges). The assessor's site may have the values and base year when the tax collector's does not; visit it if there is time.
Rules: read only. Never pay, never start a payment or checkout, never enroll in anything, never create an account or sign in, never enter anything except the parcel number or the street address into a search. Prefer official county (.gov, .us, .org of the county) pages and the vendors they link to; ignore paid property-record aggregators and ads. A search engine results page is only for finding the county's site. If a page asks to verify you are human and you cannot get past it, or the site does not load, try the county's other official search (assessor, a second search page) once, then report found false and say what stopped you.
When done, call report once — always with the parcel number (apn) and the parcel's situs address as the county shows them — and with everything the pages showed — never estimate a figure the page did not show.`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const deadline = Date.now() + RUN_MS;
  try {
    say(`Opening ${new URL(start).hostname}`);
    await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `The browser is open.\n\n${await describe(page, [])}` }];
    while (Date.now() < deadline && run.steps < MAX_STEPS && run.costUsd < MAX_USD) {
      const res = await meteredCreate(client, 'tax-lookup', { ...paramsFor(PRIMARY_MODEL, { maxTokens: 3000, system, messages, cache: true }), tools: TOOLS });
      run.steps++;
      run.costUsd += costOf(PRIMARY_MODEL, res.usage);
      messages.push({ role: 'assistant', content: res.content });
      const uses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
      if (!uses.length) { run.error = 'The lookup stopped without reporting.'; break; }
      const results: Anthropic.ToolResultBlockParam[] = [];
      let finished = false;
      for (const u of uses) {
        const i = u.input as any;
        let content: Anthropic.ToolResultBlockParam['content'] = '';
        try {
          switch (u.name) {
            case 'look': content = await describe(page, []); break;
            case 'screenshot': content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: (await page.screenshot({ type: 'png', scale: 'css' })).toString('base64') } }]; break;
            case 'click': say('Reading the county site'); await refLocator(page, Number(i.ref)).click({ timeout: 10000 }); content = await after('Clicked.'); break;
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
              say(`Opening ${url.hostname}`);
              await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
              content = await after('Opened.');
              break;
            }
            case 'report':
              run.report = cleanReport(i);
              if (!run.report.sourceUrl) run.report.sourceUrl = page.url();
              run.ok = run.report.found;
              if (!run.report.found) run.error = run.report.notes || 'The county site did not show the parcel.';
              content = 'Reported.';
              finished = true;
              break;
            default: content = `Unknown tool ${u.name}`;
          }
        } catch (err) {
          content = `That did not work: ${err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : String(err)}\n\n${await describe(page, []).catch(() => '')}`;
        }
        results.push({ type: 'tool_result', tool_use_id: u.id, content });
      }
      messages.push({ role: 'user', content: results });
      if (finished) break;
    }
    if (!run.report && !run.error) run.error = 'The lookup ran out of time before it could report.';
  } catch (err) {
    run.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
  } finally {
    await close();
  }
  return run;
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
  const prop = await db.property.findUnique({ where: { id: propertyId }, select: { apn: true, county: true } });
  // The parcel number (and county) the county site showed fill what is missing.
  const fill = { ...(r.apn && !prop?.apn ? { apn: r.apn } : {}), ...(r.county && !prop?.county ? { county: r.county.replace(/\s+county$/i, '') } : {}) };
  if (Object.keys(fill).length) await db.property.update({ where: { id: propertyId }, data: fill });
  const existing = await db.taxAssessment.findMany({ where: { propertyId }, select: { id: true, taxYear: true } });
  let years = 0;
  for (const y of r.years ?? []) {
    // The year's total: as shown, or both installments' sum; one installment alone is not the year.
    const total = y.annualTaxAmount ?? (y.installment1Amount != null && y.installment2Amount != null ? Number((y.installment1Amount + y.installment2Amount).toFixed(2)) : null);
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
    else if (total != null) {
      const created = await db.taxAssessment.create({ data: { propertyId, taxYear: y.taxYear, ...(data as any), annualTaxAmount: total } });
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
