/**
 * An address suggestion as the forms fill it: street line, city, two-letter
 * state, ZIP, county. Pure parts of services/addressSuggest.ts — reading
 * Google Places' address components and Photon's (OpenStreetMap) features.
 */

export interface AddressParts {
  line1: string;
  city: string;
  state: string;
  zip: string;
  county: string;
  label: string;
}

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR',
};

/** "California" or "CA" → "CA"; anything else as given. */
export function stateCode(s: string | undefined | null): string {
  const v = (s ?? '').trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return STATES[v.toLowerCase()] ?? v;
}

const label = (p: Omit<AddressParts, 'label'>) =>
  [p.line1, p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

/** Google Places (New) `addressComponents` → parts. */
export function fromGoogleComponents(components: { longText?: string; shortText?: string; types?: string[] }[]): AddressParts {
  const get = (type: string, short = false) => {
    const c = components.find(x => x.types?.includes(type));
    return (short ? c?.shortText : c?.longText) ?? '';
  };
  const unit = get('subpremise');
  const street = [get('street_number'), get('route', true) || get('route')].filter(Boolean).join(' ');
  const parts = {
    line1: unit ? `${street} #${unit}` : street,
    city: get('locality') || get('sublocality') || get('postal_town') || get('administrative_area_level_3'),
    state: stateCode(get('administrative_area_level_1', true)),
    zip: get('postal_code'),
    county: get('administrative_area_level_2').replace(/\s+County$/i, ''),
  };
  return { ...parts, label: label(parts) };
}

/** One Photon (OpenStreetMap) feature's properties → parts, or null when it isn't a US street address. */
export function fromPhoton(p: Record<string, string | undefined>): AddressParts | null {
  if ((p.countrycode ?? '').toUpperCase() !== 'US') return null;
  const street = p.street ?? (p.type === 'street' ? p.name : undefined);
  if (!street) return null;
  const parts = {
    line1: [p.housenumber, street].filter(Boolean).join(' '),
    city: p.city ?? p.town ?? p.village ?? p.district ?? '',
    state: stateCode(p.state),
    zip: (p.postcode ?? '').split(/[;,]/)[0].trim(),
    county: (p.county ?? '').replace(/\s+County$/i, ''),
  };
  return { ...parts, label: label(parts) };
}
