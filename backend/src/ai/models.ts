/**
 * Which Claude models Sollux uses, in one place. Everything that reads a
 * document or writes text asks the primary model first; when that call
 * fails (overloaded, unavailable, refused, cut off) or its answer does not
 * pass the caller's check — no JSON, figures that do not add up — the same
 * request goes to the fallback, the stronger model, once.
 *
 * Both are set by environment variable, so the owner can change them on
 * Render without a deploy of new code:
 *   CLAUDE_MODEL           default claude-sonnet-5
 *   CLAUDE_FALLBACK_MODEL  default claude-opus-5-5 ("none" turns fallback off)
 */
import Anthropic from '@anthropic-ai/sdk';

export const PRIMARY_MODEL = process.env.CLAUDE_MODEL?.trim() || 'claude-sonnet-5';
const fallbackEnv = process.env.CLAUDE_FALLBACK_MODEL?.trim();
export const FALLBACK_MODEL: string | null = fallbackEnv?.toLowerCase() === 'none' ? null : fallbackEnv || 'claude-opus-5-5';

export interface AskOptions {
  /** Room for the answer itself; thinking headroom is added where a model always thinks. */
  maxTokens: number;
  system?: string;
  messages: Anthropic.MessageParam[];
  /** null when the answer is usable; otherwise why the fallback should try. */
  check?: (text: string) => string | null;
  /** For log lines: the file or job the call is for. */
  label?: string;
}
export interface AskResult { text: string; model: string; fellBack: boolean }

/** The request shape each model family accepts. */
export function paramsFor(model: string, o: AskOptions): Anthropic.MessageCreateParamsNonStreaming {
  const base: Anthropic.MessageCreateParamsNonStreaming = {
    model, max_tokens: o.maxTokens, messages: o.messages, ...(o.system ? { system: o.system } : {}),
  };
  // Opus 5.5 and Fable always think — thinking can't be turned off, only
  // turned down with effort, and it counts against max_tokens.
  if (/opus-5-5|fable/.test(model)) return { ...base, max_tokens: o.maxTokens + 16000, output_config: { effort: 'medium' } };
  // Sonnet 5 and Opus 5 think by default; reading a bill into JSON does not
  // need it, and leaving it on would spend the answer's tokens on reasoning.
  if (/sonnet-5|opus-5/.test(model)) return { ...base, thinking: { type: 'disabled' } };
  return base;
}

const textOf = (m: Anthropic.Message) => m.content.map(c => (c.type === 'text' ? c.text : '')).join('').trim();

async function once(client: Anthropic, model: string, o: AskOptions): Promise<{ text: string; problem: string | null }> {
  const res = await client.messages.create(paramsFor(model, o));
  const text = textOf(res);
  if (res.stop_reason === 'refusal') return { text, problem: 'refused' };
  if (res.stop_reason === 'max_tokens') return { text, problem: 'cut off at max_tokens' };
  if (!text) return { text, problem: 'no text came back' };
  return { text, problem: o.check?.(text) ?? null };
}

/**
 * Ask the primary model; fall back once to the stronger model when the
 * primary errors or its answer fails the check. If the fallback cannot do
 * better, the primary's answer (when there was one) is kept rather than lost.
 * Errors that no model can fix — a bad key, a document the API rejects —
 * are thrown without trying the fallback.
 */
export async function askClaude(client: Anthropic, o: AskOptions): Promise<AskResult> {
  let first: { text: string; problem: string | null } | null = null;
  let firstErr: unknown = null;
  try {
    first = await once(client, PRIMARY_MODEL, o);
    if (!first.problem) return { text: first.text, model: PRIMARY_MODEL, fellBack: false };
  } catch (err) {
    if (!worthRetrying(err)) throw err;
    firstErr = err;
  }
  if (!FALLBACK_MODEL || FALLBACK_MODEL === PRIMARY_MODEL) {
    if (first) return { text: first.text, model: PRIMARY_MODEL, fellBack: false };
    throw firstErr;
  }
  const why = first?.problem ?? (firstErr instanceof Error ? firstErr.message : String(firstErr));
  console.warn(`[Claude] ${o.label ?? 'request'}: ${PRIMARY_MODEL} — ${why}; trying ${FALLBACK_MODEL}`);
  try {
    const second = await once(client, FALLBACK_MODEL, o);
    if (!second.problem || !first?.text) return { text: second.text, model: FALLBACK_MODEL, fellBack: true };
    return { text: first.text, model: PRIMARY_MODEL, fellBack: false };
  } catch (err) {
    if (first?.text) return { text: first.text, model: PRIMARY_MODEL, fellBack: false };
    throw firstErr ?? err;
  }
}

/** Overloaded, rate-limited, down or a model this key cannot use: another model may answer. */
export function worthRetrying(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status == null) return true; // network trouble
  if (status === 401 || status === 403) return false; // the key, not the model
  if (status === 400) return /model|thinking|effort|output_config/i.test(String((err as Error).message));
  return status === 404 || status === 408 || status === 409 || status === 429 || status >= 500;
}

/** The first {...} in a reply, parsed; null when there is none or it is not JSON. */
export function jsonIn(text: string): any | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
export const needsJson = (text: string) => (jsonIn(text) ? null : 'no JSON in the answer');
