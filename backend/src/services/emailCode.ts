/**
 * Verification codes and sign-in links from the owner's own inbox. When a
 * portal emails a one-time code, or a link that signs you in ("magic link",
 * Dignity Memorial's "Access your Account"), the portal agent looks here
 * before it asks the owner: the connected Gmail accounts are searched for a
 * message from the portal that arrived after this fetch began.
 *
 * Nothing is kept: the code or link goes straight to the browser and into the
 * agent's list of secrets (scrubbed from what Claude sees).
 */
import { google } from 'googleapis';
import { db } from '../config/db';
import { oauthFor, walk, decode, htmlToText } from '../ai/inboxAgent';

const KEYWORDS = '(code OR verification OR passcode OR "one-time" OR "one time" OR OTP OR "security code" OR "sign in" OR "log in" OR "login")';

/** The code in an email: a 4–8 digit number next to a code-like word, else a lone 6-digit number. */
export function codeIn(subject: string, body: string): string | null {
  const text = `${subject}\n${body}`.replace(/ /g, ' ');
  const near = text.match(/(?:code|passcode|pin|otp|verification|one[- ]time)[^0-9\n]{0,60}?\b(\d{4,8})\b/i)
    ?? text.match(/\b(\d{4,8})\b[^0-9\n]{0,40}(?:is your|is the)\s+(?:[\w-]+\s+){0,3}(?:code|passcode|pin)/i);
  if (near) return near[1];
  const lone = text.match(/^\s*(\d{6})\s*$/m);
  return lone ? lone[1] : null;
}

/** How well a sender matches the portal: its own domain, or its name in the address. */
function senderScore(from: string, host: string, providerName: string): number {
  const f = from.toLowerCase();
  const root = host.split('.').slice(-2).join('.').toLowerCase();
  if (root && f.includes(root)) return 2;
  const word = providerName.toLowerCase().split(/[^a-z]+/).find(w => w.length >= 4);
  return word && f.includes(word) ? 1 : 0;
}

/**
 * What a search saw, so a miss can say why: which inboxes were read, which
 * could not be (an expired Gmail connection), and whether mail from the
 * portal came in without anything usable in it.
 */
export interface MailReport { inboxes: string[]; errors: string[]; fromPortal: number }

/** A sentence for the owner on why no code or link was found. */
export function mailMiss(r: MailReport, host: string, since: Date): string {
  const at = since.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  if (!r.inboxes.length) return 'No Gmail is connected to Sollux, so codes cannot be read automatically — connect the inbox that receives them in Settings.';
  if (r.errors.length) return `Could not read ${r.errors.join('; ')} — reconnect that Gmail in Settings.`;
  if (r.fromPortal) return `Mail from ${host} arrived in ${r.inboxes.join(', ')}, but no code or link could be read in it.`;
  return `Nothing from ${host} arrived in ${r.inboxes.join(', ')} since ${at} — if the code goes to another inbox, connect that one in Settings.`;
}

/** One message from the owner's inbox, as the pickers below read it. */
interface Mail { subject: string; from: string; text: string; html: string; at: number }

/**
 * Wait up to timeoutMs for mail sent after `since` that `pick` finds something
 * in, checking every few seconds. Only mail from the portal itself (its domain,
 * or its name in the sender) counts: something from another sign-in that
 * happened to arrive is never used. Null when nothing arrives (no Gmail
 * connected, or it went to a phone).
 */
async function waitForMail(userId: string, o: MailSearch & { query: string }, pick: (m: Mail) => string | null): Promise<string | null> {
  const tokens = await db.gmailToken.findMany({ where: { userId } });
  if (o.report) o.report.inboxes = tokens.map(t => t.email);
  if (!tokens.length) return null;
  const until = Date.now() + (o.timeoutMs ?? 120_000);
  const after = Math.floor(o.since.getTime() / 1000);
  const seen = new Set<string>();
  while (Date.now() < until && !o.stop?.()) {
    const found: { value: string; score: number; at: number }[] = [];
    for (const token of tokens) {
      try {
        const gmail = google.gmail({ version: 'v1', auth: oauthFor(token) });
        const list = await gmail.users.messages.list({ userId: 'me', q: `after:${after} ${o.query}`, maxResults: 10 });
        for (const m of list.data.messages ?? []) {
          if (!m.id || seen.has(m.id)) continue;
          seen.add(m.id);
          const msg = (await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' })).data;
          const at = Number(msg.internalDate ?? 0);
          if (at < o.since.getTime()) continue; // sent before this fetch began: an old one
          const headers = msg.payload?.headers ?? [];
          const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value ?? '';
          const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value ?? '';
          const parts = walk(msg.payload ?? undefined);
          const plain = parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
          const htmlPart = parts.find(p => p.mimeType === 'text/html' && p.body?.data);
          const html = htmlPart ? decode(htmlPart.body!.data).toString('utf8') : '';
          const text = plain ? decode(plain.body!.data).toString('utf8') : html ? htmlToText(html) : msg.snippet ?? '';
          const value = pick({ subject, from, text, html, at });
          const score = senderScore(from, o.host, o.providerName);
          if (value) found.push({ value, score, at });
          else if (score > 0 && o.report) o.report.fromPortal++;
        }
      } catch (err) {
        const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
        console.warn(`[EmailCode] could not read ${token.email}:`, why);
        const line = `${token.email} (${why.slice(0, 80)})`;
        if (o.report && !o.report.errors.includes(line)) o.report.errors.push(line);
      }
    }
    found.sort((a, b) => b.score - a.score || b.at - a.at);
    if (found.length && found[0].score > 0) return found[0].value;
    await new Promise(r => setTimeout(r, 6000));
  }
  return null;
}

interface MailSearch { since: Date; host: string; providerName: string; timeoutMs?: number; report?: MailReport; stop?: () => boolean }

/** A code emailed after `since` (prefers the portal's own domain), not one in `exclude`. */
export function findEmailedCode(userId: string, o: MailSearch & { exclude?: string[] }): Promise<string | null> {
  return waitForMail(userId, { ...o, query: KEYWORDS }, m => {
    const code = codeIn(m.subject, m.text);
    return code && !o.exclude?.includes(code) ? code : null;
  });
}

const LINK_WORDS = /log ?in|sign ?in|access|verify|confirm|continue|open (my )?account|get started/i;
const NOT_SIGN_IN = /unsubscribe|privacy|preferences|subscriptions|terms|help|support|contact|facebook|twitter|instagram|linkedin|youtube|view (it )?in (your )?browser|\.(png|jpe?g|gif)(\?|$)/i;

/**
 * The sign-in link ("magic link") in an email: the button or link whose text
 * says to log in or access the account (Dignity Memorial's "LOG IN"), else a
 * link whose address looks like a sign-in. Never an unsubscribe or footer link.
 */
export function signInLinkIn(html: string, text: string): string | null {
  const links: { href: string; label: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    links.push({ href: m[1].replace(/&amp;/g, '&'), label: htmlToText(m[2]).replace(/\s+/g, ' ').trim() });
  }
  if (!links.length) for (const m of text.matchAll(/https:\/\/[^\s<>"')\]]+/g)) links.push({ href: m[0], label: '' });
  const ok = links.filter(l => /^https:\/\//i.test(l.href) && !NOT_SIGN_IN.test(l.href) && !NOT_SIGN_IN.test(l.label));
  return ok.find(l => l.label && LINK_WORDS.test(l.label) && l.label.length < 40)?.href
    ?? ok.find(l => /login|signin|sign-in|auth|magic|token|verify|access/i.test(l.href))?.href
    ?? null;
}

/** A sign-in link the portal emailed after `since`. */
export function findEmailedLink(userId: string, o: MailSearch): Promise<string | null> {
  return waitForMail(userId, { ...o, query: '(link OR "log in" OR "sign in" OR login OR access OR verify)' }, m => signInLinkIn(m.html, m.text));
}
