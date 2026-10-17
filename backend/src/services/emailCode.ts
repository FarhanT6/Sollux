/**
 * Verification codes from the owner's own inbox. When a portal emails a
 * one-time code, the portal agent asks here before it asks the owner: the
 * connected Gmail accounts are searched for a message that arrived after the
 * code was requested, and the code is read out of it.
 *
 * Nothing is kept: the code goes straight to the browser and into the agent's
 * list of secrets (scrubbed from what Claude sees). Only mail newer than the
 * request is read, and only messages that look like a sign-in code.
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
 * Wait up to timeoutMs for a code emailed after `since`, checking every few
 * seconds. Prefers mail from the portal's own domain; null when none arrives
 * (a code sent by text, or no Gmail connected).
 */
export async function findEmailedCode(userId: string, o: { since: Date; host: string; providerName: string; timeoutMs?: number }): Promise<string | null> {
  const tokens = await db.gmailToken.findMany({ where: { userId } });
  if (!tokens.length) return null;
  const until = Date.now() + (o.timeoutMs ?? 120_000);
  const after = Math.floor((o.since.getTime() - 60_000) / 1000);
  const seen = new Set<string>();
  while (Date.now() < until) {
    const found: { code: string; score: number; at: number }[] = [];
    for (const token of tokens) {
      try {
        const gmail = google.gmail({ version: 'v1', auth: oauthFor(token) });
        const list = await gmail.users.messages.list({ userId: 'me', q: `after:${after} ${KEYWORDS}`, maxResults: 10 });
        for (const m of list.data.messages ?? []) {
          if (!m.id || seen.has(m.id)) continue;
          seen.add(m.id);
          const msg = (await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' })).data;
          const at = Number(msg.internalDate ?? 0);
          if (at < o.since.getTime() - 60_000) continue; // before the code was asked for
          const headers = msg.payload?.headers ?? [];
          const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value ?? '';
          const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value ?? '';
          const parts = walk(msg.payload ?? undefined);
          const plain = parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
          const html = parts.find(p => p.mimeType === 'text/html' && p.body?.data);
          const body = plain ? decode(plain.body!.data).toString('utf8') : html ? htmlToText(decode(html.body!.data).toString('utf8')) : msg.snippet ?? '';
          const code = codeIn(subject, body);
          if (code) found.push({ code, score: senderScore(from, o.host, o.providerName), at });
        }
      } catch (err) {
        console.warn('[EmailCode] could not read a mailbox:', err instanceof Error ? err.message.split('\n')[0] : err);
      }
    }
    // The portal's own mail first, then the newest.
    found.sort((a, b) => b.score - a.score || b.at - a.at);
    if (found.length && (found[0].score > 0 || found.length === 1)) return found[0].code;
    await new Promise(r => setTimeout(r, 6000));
  }
  return null;
}
