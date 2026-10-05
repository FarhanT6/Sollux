/**
 * The inbox agent. Every night (and on "Sync now") it reads each Gmail
 * mailbox the owner connected — bills go to more than one address — and
 * files what it finds the same way a Drive import does:
 *
 *  - a PDF attached to an email is read by Claude, matched to its utility
 *    account by account number and address, and filed when the match is
 *    confident, or staged for review in Import Bills when it is not;
 *  - an e-bill with no attachment ("Your bill is ready — $142.18 due Oct 5")
 *    is printed to a PDF from the email itself and goes through the same path;
 *  - anything else is noted and left alone.
 *
 * Each message is handled once (InboxMessage), so re-running never double
 * files or double bills. Payment confirmations are recorded, not filed.
 */
import { google, gmail_v1 } from 'googleapis';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { intakeBill, type ReviewItem } from '../services/documentIntake';

const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;

// How far back a newly connected mailbox is read, and how many documents
// Claude reads per run. Kept small: every document is a paid read, and a
// 60-day first read of two inboxes ran through a lot of credits. The rest of
// a backlog is read on later runs. Both can be raised with env vars.
const FIRST_RUN_DAYS = Number(process.env.INBOX_FIRST_RUN_DAYS) || 3;
const MAX_MESSAGES_PER_MAILBOX = 200;
const MAX_DOCUMENTS_PER_RUN = Number(process.env.INBOX_MAX_DOCUMENTS_PER_RUN) || 25;

const BILL_SUBJECT = /\b(bill|statement|invoice|payment (is )?due|amount due|balance due|past due|premium|renewal|notice|e-?bill|autopay|tax)\b/i;
const PAYMENT_CONFIRMATION = /thank you for (your )?payment|payment (received|confirmation|processed|successful)|we received your payment|receipt for your payment/i;
const BILL_WORDS = /amount due|total due|balance due|new balance|statement date|billing period|service period|due date|invoice|premium|past due|minimum payment|account (number|no|#)/i;
const MONEY = /\$\s?\d[\d,]*\.\d{2}/;

export interface InboxRunSummary {
  mailboxes: number; read: number; filed: number; review: number; applied: number; skipped: number; errors: string[]; jobId: string | null;
}

function oauthFor(token: { id: string; accessToken: string; refreshToken: string; expiresAt: Date }) {
  const client = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REDIRECT_URI);
  client.setCredentials({ access_token: token.accessToken, refresh_token: token.refreshToken, expiry_date: token.expiresAt.getTime() });
  // Keep the refreshed token so the next run does not start from an expired one.
  client.on('tokens', t => {
    db.gmailToken.update({
      where: { id: token.id },
      data: { ...(t.access_token ? { accessToken: t.access_token } : {}), ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}), ...(t.expiry_date ? { expiresAt: new Date(t.expiry_date) } : {}) },
    }).catch(() => {});
  });
  return client;
}

type Part = gmail_v1.Schema$MessagePart;
function walk(part: Part | undefined, out: Part[] = []): Part[] {
  if (!part) return out;
  out.push(part);
  for (const p of part.parts ?? []) walk(p, out);
  return out;
}
const header = (m: gmail_v1.Schema$Message, name: string) => m.payload?.headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
const decode = (data?: string | null) => (data ? Buffer.from(data, 'base64url') : Buffer.alloc(0));

function htmlToText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;|&dollar;/g, '$').replace(/[ \t]+/g, ' ').trim();
}

/** Whether an email with no attachment is itself a bill worth reading. */
export function isBillEmail(subject: string, body: string): boolean {
  if (PAYMENT_CONFIRMATION.test(subject)) return false;
  return BILL_SUBJECT.test(subject) && MONEY.test(body) && BILL_WORDS.test(body);
}
/** Whether an attached PDF is a bill, judged from its text before paying for a read. */
export function looksLikeBill(text: string): boolean {
  return BILL_WORDS.test(text) && MONEY.test(text);
}

// One browser for the whole run, opened only if an e-bill needs printing.
let browserP: Promise<import('playwright').Browser> | null = null;
async function printToPdf(html: string): Promise<Buffer> {
  if (!browserP) browserP = import('playwright').then(pw => pw.chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] }));
  const browser = await browserP;
  const page = await browser.newPage();
  try {
    // Nothing leaves the machine: tracking pixels and remote images are blocked.
    await page.route('**/*', r => (r.request().url().startsWith('data:') ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return Buffer.from(await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' } }));
  } finally { await page.close().catch(() => {}); }
}
/**
 * The same e-bill as a plain PDF, made without a browser. Used when
 * Chromium cannot start (it was missing on Render, and every email without
 * an attachment failed). The layout is lost but the words and figures that
 * bill readers need are all there.
 */
export async function textToPdf(text: string): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 10, lineH = 13, margin = 40, width = 612 - margin * 2;
  // The standard font covers Latin-1 only; anything else becomes a space.
  const clean = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF]/g, ' ');
  const lines: string[] = [];
  for (const raw of clean.split('\n')) {
    let line = '';
    for (const word of raw.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = word; } else line = next;
    }
    lines.push(line);
  }
  let page = doc.addPage([612, 792]);
  let y = 792 - margin;
  for (const line of lines) {
    if (y < margin) { page = doc.addPage([612, 792]); y = 792 - margin; }
    if (line) page.drawText(line, { x: margin, y, size, font });
    y -= lineH;
  }
  return Buffer.from(await doc.save());
}

async function closeBrowser() {
  if (!browserP) return;
  const b = browserP; browserP = null;
  await (await b).close().catch(() => {});
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function runInboxAgent(userId: string, opts: { tokenId?: string } = {}): Promise<InboxRunSummary> {
  const tokens = await db.gmailToken.findMany({ where: { userId, ...(opts.tokenId ? { id: opts.tokenId } : {}) }, orderBy: { createdAt: 'asc' } });
  const sum: InboxRunSummary = { mailboxes: tokens.length, read: 0, filed: 0, review: 0, applied: 0, skipped: 0, errors: [], jobId: null };
  if (!tokens.length) return sum;

  const batchId = `inbox-${Date.now()}`;
  const review: ReviewItem[] = [];
  let documents = 0;

  try {
    // Each mailbox gets its own share of the run's document allowance. A
    // shared one let the first mailbox's backlog use all of it, and the
    // second was never read ("not read yet" for fhmtalukder@).
    const perMailbox = Math.max(5, Math.floor(MAX_DOCUMENTS_PER_RUN / tokens.length));
    for (const token of tokens) {
      const startedAt = new Date();
      const budgetEnd = documents + perMailbox;
      try {
        const gmail = google.gmail({ version: 'v1', auth: oauthFor(token) });
        const since = token.lastScanAt ? new Date(token.lastScanAt.getTime() - 24 * 3600 * 1000) : new Date(Date.now() - FIRST_RUN_DAYS * 24 * 3600 * 1000);
        const q = `after:${Math.floor(since.getTime() / 1000)} -category:promotions -category:social (has:attachment OR subject:(bill OR statement OR invoice OR due OR notice OR premium OR renewal OR tax))`;

        const ids: string[] = [];
        let pageToken: string | undefined;
        do {
          const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
          for (const m of list.data.messages ?? []) if (m.id) ids.push(m.id);
          pageToken = list.data.nextPageToken ?? undefined;
        } while (pageToken && ids.length < MAX_MESSAGES_PER_MAILBOX);

        // A message that failed is read again next run — the cause (a missing
        // browser, a timeout) is usually fixed by then. Everything else is
        // handled once.
        const prior = await db.inboxMessage.findMany({ where: { gmailTokenId: token.id, messageId: { in: ids } }, select: { messageId: true, outcome: true } });
        const seen = new Set(prior.filter(m => m.outcome !== 'error').map(m => m.messageId));
        // A message is retried once. If it fails again it is marked failed and
        // left alone, so one bad email cannot cost a read every night.
        const retrying = new Set(prior.filter(m => m.outcome === 'error').map(m => m.messageId));
        let capped = false;

        // Oldest first, so a backlog files in order and a cap leaves the newest for next run.
        for (const messageId of ids.filter(id => !seen.has(id)).reverse()) {
          if (documents >= budgetEnd) { capped = true; break; }
          const msg = (await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })).data;
          const subject = header(msg, 'Subject'), from = header(msg, 'From');
          const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)) : null;
          const record = (outcome: string, detail?: string | null, utilityAccountId?: string | null) =>
            db.inboxMessage.upsert({
              where: { gmailTokenId_messageId: { gmailTokenId: token.id, messageId } },
              create: { userId, gmailTokenId: token.id, messageId, fromAddress: from.slice(0, 300), subject: subject.slice(0, 300), receivedAt, outcome, detail: detail?.slice(0, 500) ?? null, utilityAccountId: utilityAccountId ?? null },
              update: { outcome, detail: detail?.slice(0, 500) ?? null, utilityAccountId: utilityAccountId ?? null, createdAt: new Date() },
            }).catch(() => {});
          sum.read++;

          if (PAYMENT_CONFIRMATION.test(subject)) { sum.skipped++; await record('skipped', 'payment confirmation'); continue; }

          const parts = walk(msg.payload);
          const pdfs = parts.filter(p => p.body?.attachmentId && (p.mimeType === 'application/pdf' || /\.pdf$/i.test(p.filename ?? '')));
          const outcomes: string[] = [];
          const problems: string[] = [];
          let accountId: string | null = null;

          const handle = async (buffer: Buffer, filename: string) => {
            documents++;
            const r = await intakeBill(buffer, filename, userId, 'ai', batchId, 'email');
            if (r.outcome === 'filed') { sum.filed++; accountId = r.utilityAccountId; outcomes.push('filed'); }
            else if (r.outcome === 'review') { sum.review++; review.push(r.reviewItem); outcomes.push('review'); }
            else if (r.outcome === 'error') { sum.errors.push(r.error); problems.push(r.error); outcomes.push('error'); }
            else if (r.outcome === 'not_a_bill') { outcomes.push('skipped'); problems.length || problems.push('not a bill'); }
            else { sum.applied++; outcomes.push(r.outcome); }
          };

          try {
            if (pdfs.length) {
              for (const p of pdfs) {
                const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: p.body!.attachmentId! });
                const buffer = decode(att.data.data);
                let text = '';
                try { text = (await pdfParse(buffer)).text; } catch { /* scanned or odd — let Claude decide if the email says bill */ }
                const scanned = text.replace(/\s/g, '').length < 200;
                if (scanned ? !BILL_SUBJECT.test(subject) : !looksLikeBill(text)) { outcomes.push('skipped'); continue; }
                await handle(buffer, p.filename || `${subject || 'email'}.pdf`);
              }
            } else {
              const html = parts.find(p => p.mimeType === 'text/html')?.body?.data;
              const plain = parts.find(p => p.mimeType === 'text/plain')?.body?.data;
              const body = html ? htmlToText(decode(html).toString('utf8')) : decode(plain).toString('utf8');
              if (isBillEmail(subject, body)) {
                const page = html
                  ? decode(html).toString('utf8')
                  : `<pre style="font:13px/1.4 sans-serif;white-space:pre-wrap">${esc(body)}</pre>`;
                const stamped = `<div style="font:12px sans-serif;color:#555;border-bottom:1px solid #ddd;margin-bottom:12px;padding-bottom:6px">From: ${esc(from)}<br>Subject: ${esc(subject)}<br>Received: ${receivedAt?.toISOString().slice(0, 10) ?? ''}</div>${page}`;
                let pdf: Buffer;
                try { pdf = await printToPdf(stamped); }
                catch (e) {
                  console.warn(`[InboxAgent] browser print failed (${e instanceof Error ? e.message.split('\n')[0] : e}); using a plain-text PDF`);
                  browserP = null;
                  pdf = await textToPdf(`From: ${from}\nSubject: ${subject}\nReceived: ${receivedAt?.toISOString().slice(0, 10) ?? ''}\n\n${body}`);
                }
                await handle(pdf, `${(subject || 'e-bill').replace(/[^\w .-]+/g, '').slice(0, 80)}.pdf`);
              } else outcomes.push('skipped');
            }
          } catch (err) {
            outcomes.push('error');
            const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
            problems.push(why);
            sum.errors.push(`${subject || messageId}: ${why}`);
          }

          let best = ['filed', 'review', 'notice', 'policy', 'error'].find(o => outcomes.includes(o)) ?? 'skipped';
          if (best === 'error' && retrying.has(messageId)) best = 'failed';
          if (best === 'skipped') sum.skipped++;
          // An error says why, so the log can be acted on.
          await record(best, problems.length ? problems.join('; ') : outcomes.length > 1 ? outcomes.join(', ') : null, accountId);
        }
        await db.gmailToken.update({ where: { id: token.id }, data: { lastScanAt: capped ? token.lastScanAt : startedAt, lastScanError: capped ? `Stopped at ${perMailbox} documents; the rest are read next run (or press Sync now).` : null } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sum.errors.push(`${token.email}: ${message}`);
        await db.gmailToken.update({ where: { id: token.id }, data: { lastScanError: message.slice(0, 500) } }).catch(() => {});
      }
    }
  } finally {
    await closeBrowser();
  }

  // Anything that needs a look goes to Import Bills, the same review a Drive import uses.
  if (review.length || sum.filed) {
    const job = await db.driveImportJob.create({
      data: {
        userId, source: 'email', folderName: `Email · ${tokens.map(t => t.email).join(', ')}`.slice(0, 190),
        status: sum.errors.length ? 'PARTIAL' : 'SUCCESS', totalFiles: documents, processedFiles: documents, autoImported: sum.filed,
        needsReviewJson: review as unknown as Prisma.InputJsonValue, errorLog: sum.errors.length ? sum.errors.join('\n').slice(0, 5000) : null, finishedAt: new Date(),
      },
    });
    sum.jobId = job.id;
    if (review.length) await db.inboxMessage.updateMany({ where: { userId, outcome: 'review', importJobId: null }, data: { importJobId: job.id } });
  }
  console.log(`[InboxAgent] ${userId}: ${sum.read} read, ${sum.filed} filed, ${sum.review} to review, ${sum.applied} applied, ${sum.skipped} skipped, ${sum.errors.length} errors`);
  return sum;
}

/** Every owner with a connected mailbox — the nightly run. */
export async function runInboxAgentForEveryone(): Promise<void> {
  const owners = await db.gmailToken.findMany({ distinct: ['userId'], select: { userId: true } });
  for (const { userId } of owners) {
    try { await runInboxAgent(userId); }
    catch (err) { console.warn(`[InboxAgent] ${userId} failed:`, err instanceof Error ? err.message : err); }
  }
}
