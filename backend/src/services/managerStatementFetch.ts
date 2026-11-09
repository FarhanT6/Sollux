/**
 * "Check email now" on Manager statements: a search of the owner's connected
 * Gmail, further back than the nightly read (which starts where the last one
 * stopped), for property manager statements — PDFs from an address a manager
 * profile lists, or with a statement-like subject. A PDF is read only when it
 * comes from the manager or its own text reads like an owner statement (free
 * to check); then it is recorded like any emailed statement. Oldest first, so
 * each year-to-date statement adds only what the one before did not have.
 */
import { google } from 'googleapis';
import { db } from '../config/db';
import { oauthFor, walk, decode } from '../ai/inboxAgent';
import { withAiContext } from '../ai/meter';
import { intakeManagerStatement, isManagerStatementPdf, managerForSender } from './managerStatementEmail';

import pdfParse from '../lib/pdfParse';

export interface FetchSummary { mailboxes: number; looked: number; found: number; recorded: number; already: number; details: string[]; errors: string[] }

export async function fetchManagerStatements(userId: string, days = 180): Promise<FetchSummary> {
  const tokens = await db.gmailToken.findMany({ where: { userId } });
  const sum: FetchSummary = { mailboxes: tokens.length, looked: 0, found: 0, recorded: 0, already: 0, details: [], errors: [] };
  if (!tokens.length) return sum;
  const senders = (await db.reconciliationProfile.findMany({ where: { userId, emailFrom: { not: null } }, select: { emailFrom: true } }))
    .flatMap(p => (p.emailFrom ?? '').split(/[,\s;]+/)).filter(a => a.includes('@'));
  const after = Math.floor((Date.now() - days * 86_400_000) / 1000);
  const fromSenders = senders.length ? ` OR from:(${senders.join(' OR ')})` : '';
  const q = `after:${after} has:attachment filename:pdf (subject:(statement OR "owner statement" OR "cash flow" OR "cash flows" OR "owner report" OR "monthly report" OR distribution OR rent)${fromSenders})`;

  // Every candidate across the mailboxes, oldest first.
  const found: { token: (typeof tokens)[number]; id: string; at: number }[] = [];
  for (const token of tokens) {
    try {
      const gmail = google.gmail({ version: 'v1', auth: oauthFor(token) });
      let pageToken: string | undefined;
      do {
        const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
        for (const m of list.data.messages ?? []) if (m.id) found.push({ token, id: m.id, at: 0 });
        pageToken = list.data.nextPageToken ?? undefined;
      } while (pageToken && found.length < 300);
    } catch (err) { sum.errors.push(`${token.email}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  const seenRfc = new Set<string>();
  const items: { token: (typeof tokens)[number]; msg: any }[] = [];
  for (const f of found) {
    try {
      const gmail = google.gmail({ version: 'v1', auth: oauthFor(f.token) });
      const msg = (await gmail.users.messages.get({ userId: 'me', id: f.id, format: 'full' })).data;
      const rfc = msg.payload?.headers?.find(h => h.name?.toLowerCase() === 'message-id')?.value ?? f.id;
      if (seenRfc.has(rfc)) continue;   // the same email in two mailboxes
      seenRfc.add(rfc);
      items.push({ token: f.token, msg });
    } catch (err) { sum.errors.push(err instanceof Error ? err.message : String(err)); }
  }
  items.sort((a, b) => Number(a.msg.internalDate ?? 0) - Number(b.msg.internalDate ?? 0));

  for (const { token, msg } of items) {
    sum.looked++;
    const header = (n: string) => msg.payload?.headers?.find((h: any) => h.name?.toLowerCase() === n)?.value ?? '';
    const from = header('from'), subject = header('subject');
    const rfc = header('message-id') || msg.id;
    const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)) : null;
    const fromManager = await managerForSender(userId, from);
    const gmail = google.gmail({ version: 'v1', auth: oauthFor(token) });
    for (const p of walk(msg.payload).filter(x => x.body?.attachmentId && (x.mimeType === 'application/pdf' || /\.pdf$/i.test(x.filename ?? '')))) {
      try {
        const ref = `${rfc}|${p.filename ?? ''}`;
        if (await db.reconciliationStatement.findFirst({ where: { userId, sourceRef: ref }, select: { id: true } })) { sum.already++; continue; }
        const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId: msg.id, id: p.body!.attachmentId! });
        const buffer = decode(att.data.data);
        let text = '';
        try { text = (await pdfParse(buffer)).text; } catch { /* scanned: only the manager's own address counts */ }
        if (!isManagerStatementPdf(text, !!fromManager)) continue;
        sum.found++;
        const r = await withAiContext({ userId, source: 'manager-statement' }, () => intakeManagerStatement(userId, buffer, p.filename || `${subject || 'statement'}.pdf`, from, receivedAt, ref));
        if (/already fetched/.test(r.detail)) sum.already++; else { sum.recorded++; sum.details.push(`${receivedAt?.toISOString().slice(0, 10) ?? ''} ${r.detail}`); }
      } catch (err) { sum.errors.push(`${subject || msg.id}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`); }
    }
  }
  return sum;
}
