/**
 * Address suggestions while the owner types an address. Google Places when
 * GOOGLE_PLACES_API_KEY (or GOOGLE_MAPS_API_KEY) is set — the most complete
 * for house numbers — otherwise Photon, OpenStreetMap's free search, which
 * needs no key. The API calls them so no key reaches the browser.
 *
 * Google is two steps (suggestions, then the chosen place's parts) billed as
 * one session when both carry the same session token; Photon answers with
 * the parts at once.
 */
import { AddressParts, fromGoogleComponents, fromPhoton } from '../lib/addressParts';

export interface AddressSuggestion {
  label: string;
  /** Google: look the parts up with `addressDetails` on pick. */
  placeId?: string;
  /** Photon: the parts already. */
  parts?: AddressParts;
}

const googleKey = () => process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';

// A few minutes of the same text typed again (backspace, retype) costs nothing.
const cache = new Map<string, { at: number; value: AddressSuggestion[] }>();
const TTL = 10 * 60_000;

export async function suggestAddresses(q: string, sessionToken?: string): Promise<AddressSuggestion[]> {
  const text = q.trim().replace(/\s+/g, ' ');
  if (text.length < 3) return [];
  const key = `${googleKey() ? 'g' : 'p'}:${text.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = googleKey() ? await google(text, sessionToken) : await photon(text);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
  return value;
}

async function google(input: string, sessionToken?: string): Promise<AddressSuggestion[]> {
  const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': googleKey() },
    body: JSON.stringify({
      input,
      includedRegionCodes: ['us'],
      includedPrimaryTypes: ['street_address', 'premise', 'subpremise', 'route'],
      ...(sessionToken ? { sessionToken } : {}),
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`Address search failed (${r.status})`);
  const data = await r.json() as { suggestions?: { placePrediction?: { placeId: string; text?: { text: string } } }[] };
  return (data.suggestions ?? [])
    .map(s => s.placePrediction)
    .filter((p): p is { placeId: string; text?: { text: string } } => !!p?.placeId)
    .map(p => ({ placeId: p.placeId, label: (p.text?.text ?? '').replace(/, USA$/, '') }));
}

export async function addressDetails(placeId: string, sessionToken?: string): Promise<AddressParts> {
  if (!googleKey()) throw new Error('Address lookup is not set up');
  const qs = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : '';
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${qs}`, {
    headers: { 'X-Goog-Api-Key': googleKey(), 'X-Goog-FieldMask': 'addressComponents' },
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`Address lookup failed (${r.status})`);
  const data = await r.json() as { addressComponents?: { longText?: string; shortText?: string; types?: string[] }[] };
  return fromGoogleComponents(data.addressComponents ?? []);
}

async function photon(q: string): Promise<AddressSuggestion[]> {
  // The continental US, Alaska and Hawaii; results outside the US are dropped below.
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=10&lang=en&bbox=-180,15,-60,72`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Sollux address search' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`Address search failed (${r.status})`);
  const data = await r.json() as { features?: { properties: Record<string, string> }[] };
  const seen = new Set<string>();
  const out: AddressSuggestion[] = [];
  for (const f of data.features ?? []) {
    const parts = fromPhoton(f.properties);
    if (!parts || seen.has(parts.label)) continue;
    seen.add(parts.label);
    out.push({ label: parts.label, parts });
    if (out.length >= 6) break;
  }
  return out;
}
