/**
 * Deciding whether two provider names refer to the same company.
 *
 * Bills, scrapers and hand entry spell the same provider many ways: "SDGE",
 * "SDG&E", "San Diego Gas & Electric". Plain substring comparison catches the
 * first two and misses the third, which is how one provider ends up with
 * several accounts.
 *
 * Three rules, deliberately narrow — a false match merges two real accounts
 * together, which is worse than leaving a duplicate for a human to spot.
 */

/** Lowercase, letters and digits only. "SDG&E" -> "sdge" */
export function compact(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Words that carry no identity. Kept deliberately short: dropping "District"
// would reduce "Vista Irrigation District" to "vi" and lose the VID match.
const NOISE = new Set(['of', 'the', 'and', 'a', 'inc', 'llc', 'lp', 'corp', 'co']);

export function significantWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 0 && !NOISE.has(w));
}

/** First letter of each significant word. "Waste Management" -> "wm" */
export function acronymOf(name: string): string {
  return significantWords(name).map(w => w[0]).join('');
}

/**
 * Can `short` be built by taking a prefix of each word of `words`, in order?
 * "socalgas" from ["southern","california","gas"] -> so|cal|gas. Catches the
 * syllable abbreviations that initials miss.
 *
 * Every word consulted must contribute at least one character, which is what
 * stops "cox" matching "City of Oceanside": c from "city", o from "of", then
 * "oceanside" cannot supply the x.
 */
function prefixChunksMatch(short: string, words: string[]): boolean {
  let i = 0;
  for (const word of words) {
    if (i >= short.length) break;
    let k = 0;
    while (k < word.length && i + k < short.length && short[i + k] === word[k]) k++;
    if (k === 0) return false;
    i += k;
  }
  return i === short.length;
}

/**
 * Do these two names refer to the same provider?
 *
 * Callers should still constrain by category — this answers "same company",
 * not "same account", and one company can bill for several services.
 */
export function providersLookAlike(a: string, b: string): boolean {
  const x = compact(a);
  const y = compact(b);
  if (!x || !y) return false;
  if (x === y) return true;

  // Substring, but only when the shorter side is long enough to be meaningful.
  // Without the floor, a two-letter name matches almost anything.
  const shorter = x.length <= y.length ? x : y;
  const longer = shorter === x ? y : x;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;

  const wordsA = significantWords(a);
  const wordsB = significantWords(b);

  // Initials, compared exactly. "sdge" == acronym("San Diego Gas & Electric").
  // Exact rather than substring: "co" (City of Oceanside) must not match "cox".
  if (wordsA.length >= 2 && acronymOf(a).length >= 2 && acronymOf(a) === y) return true;
  if (wordsB.length >= 2 && acronymOf(b).length >= 2 && acronymOf(b) === x) return true;

  // Syllable abbreviations: "socalgas" from "Southern California Gas".
  if (wordsB.length >= 2 && x.length >= 3 && prefixChunksMatch(x, wordsB)) return true;
  if (wordsA.length >= 2 && y.length >= 3 && prefixChunksMatch(y, wordsA)) return true;

  return false;
}
