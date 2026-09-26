// Generates src/styles/theme-light.generated.css.
//
// Sollux was built dark, with its colors written straight into Tailwind
// classes ("text-gray-400", "bg-white/5", "hover:text-white") across every
// page. The light theme remaps them rather than rewriting each page: this
// script reads every class the source actually uses and writes a rule for
// each one, scoped to html[data-theme="light"], with its variant (hover:,
// focus:, group-hover:, md:, placeholder:) intact. Exact-token selectors
// ([class~="…"]) keep "bg-white/5" from also catching "hover:bg-white/5".
//
// Runs before every build (package.json), so a class added to a page later
// is themed without anyone remembering to. Hand-written rules for inline
// styles and component classes live in theme-light.css.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src');
const OUT = join(SRC, 'styles', 'theme-light.generated.css');

// The utility-statement palette.
const INK = '#1c2230';
const INK2 = '#2b3140';
const ACCENT = '#b8674a';
const ACCENT_DARK = '#9f563c';
const RULE = '#e6e0da';
const RULE_SOFT = '#ede8e3';

const TEXT_GRAY = { 50: INK, 100: INK, 200: INK, 300: INK2, 400: '#4b5563', 500: '#6b7280', 600: '#8a8f98', 700: '#a3a7ae', 800: '#c4c7cc', 900: '#d6d8db' };
const TEXT_HUE = {
  amber: s => (s >= 600 ? '#92400e' : s <= 200 ? '#92400e' : '#b45309'),
  gold: s => (s >= 600 ? ACCENT_DARK : ACCENT),
  emerald: () => '#047857',
  green: () => '#15803d',
  red: s => (s >= 600 ? '#991b1b' : '#b91c1c'),
  sky: () => '#0369a1',
  blue: () => '#1d4ed8',
  indigo: () => '#4338ca',
  purple: () => '#6d28d9',
  orange: () => '#c2410c',
};

// For the deep washes a dark UI puts behind a badge ("bg-red-900/40"): on
// paper the same hue is a pale tint, and its border a mid tone.
const HUE_RGB = { amber: '217, 119, 6', red: '220, 38, 38', green: '22, 163, 74', emerald: '5, 150, 105', blue: '37, 99, 235', orange: '234, 88, 12', purple: '124, 58, 237' };

/** The declaration for one utility, or null to leave it alone. */
function declFor(util) {
  let m;
  if (util === 'text-white') return `color: ${INK}`;
  if ((m = util.match(/^text-gray-(\d+)(?:\/\d+)?$/))) return `color: ${TEXT_GRAY[m[1]] ?? INK2}`;
  if ((m = util.match(/^text-(amber|gold|emerald|green|red|sky|blue|indigo|purple|orange)-(\d+)(?:\/\d+)?$/))) return `color: ${TEXT_HUE[m[1]](Number(m[2]))}`;
  if (/^text-\[#f5a623\](?:\/\d+)?$/i.test(util)) return `color: ${ACCENT}`;
  if ((m = util.match(/^bg-(amber|red|green|emerald|blue|orange|purple)-(800|900)(?:\/\d+)?$/))) return `background-color: rgba(${HUE_RGB[m[1]]}, 0.1)`;
  if ((m = util.match(/^border-(amber|red|green|emerald|blue|orange|purple)-(700|800|900)(?:\/\d+)?$/))) return `border-color: rgba(${HUE_RGB[m[1]]}, 0.35)`;
  if ((m = util.match(/^placeholder-gray-(\d+)$/))) return `color: ${TEXT_GRAY[m[1]] ?? '#8a8f98'}`;

  // A white wash lightens a dark surface; on paper it becomes a faint ink wash.
  if ((m = util.match(/^bg-white\/(\d+)$/))) return `background-color: rgba(28, 34, 48, ${Math.min(0.12, Number(m[1]) / 100 * 0.7).toFixed(3)})`;
  if ((m = util.match(/^bg-black\/(\d+)$/))) return `background-color: rgba(28, 34, 48, ${(Number(m[1]) / 100 * 0.55).toFixed(3)})`;
  if ((m = util.match(/^bg-gray-(\d+)(?:\/(\d+))?$/))) {
    const shade = Number(m[1]);
    const base = shade >= 700 ? '239, 233, 228' : shade >= 500 ? '230, 224, 218' : '243, 239, 234';
    return `background-color: rgba(${base}, ${m[2] ? Number(m[2]) / 100 : 1})`;
  }
  if ((m = util.match(/^bg-gold-(\d+)$/))) return `background-color: ${Number(m[1]) >= 600 ? ACCENT_DARK : ACCENT}`;
  if ((m = util.match(/^bg-gold-\d+\/(\d+)$/))) return `background-color: rgba(184, 103, 74, ${Number(m[1]) / 100})`;
  if (/^bg-\[#f5a623\]$/i.test(util)) return `background-color: ${ACCENT}`;
  if (/^bg-\[#1[0-9a-f]{5}\]$/i.test(util)) return `background-color: #f5f1ec`;

  if ((m = util.match(/^border-white\/(\d+)$/))) return `border-color: ${Number(m[1]) >= 10 ? RULE : RULE_SOFT}`;
  if ((m = util.match(/^border-gray-(\d+)$/))) return `border-color: ${RULE}`;
  if ((m = util.match(/^border-gold-\d+$/)) || /^border-\[#f5a623\]$/i.test(util)) return `border-color: ${ACCENT}`;
  if ((m = util.match(/^border-gold-\d+\/(\d+)$/))) return `border-color: rgba(184, 103, 74, ${Number(m[1]) / 100})`;
  if ((m = util.match(/^divide-white\/(\d+)$/))) return `border-color: ${Number(m[1]) >= 10 ? RULE : RULE_SOFT}`;
  return null;
}

const PSEUDO = { hover: ':hover', 'peer-checked': '',  focus: ':focus', active: ':active', disabled: ':disabled', 'focus-within': ':focus-within', 'focus-visible': ':focus-visible' };
const MEDIA = { sm: 640, md: 768, lg: 1024, xl: 1280 };

function ruleFor(token) {
  const parts = token.split(':');
  const util = parts.pop();
  const decl = declFor(util);
  if (!decl) return null;
  let media = null, pseudo = '', groupHover = false, placeholder = false, peerChecked = false;
  for (const v of parts) {
    if (v === 'peer-checked') peerChecked = true;
    else if (PSEUDO[v]) pseudo += PSEUDO[v];
    else if (MEDIA[v]) media = MEDIA[v];
    else if (v === 'group-hover') groupHover = true;
    else if (v === 'placeholder') placeholder = true;
    else return null; // a variant we do not know how to express
  }
  const tok = `[class~="${token}"]`;
  let sel = `${groupHover ? '.group:hover ' : ''}${peerChecked ? '.peer:checked ~ ' : ''}${tok}${pseudo}`;
  if (placeholder || util.startsWith('placeholder-')) sel += '::placeholder';
  if (util.startsWith('divide-')) sel += ' > * + *';
  const rule = `html[data-theme="light"] ${sel} { ${decl} !important; }`;
  return media ? `@media (min-width: ${media}px) { ${rule} }` : rule;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

const TOKEN = /(?<![\w-])((?:[a-z-]+:)*(?:bg|border|divide|text|placeholder)-(?:white|black|gray-\d+|gold-\d+|amber-\d+|emerald-\d+|red-\d+|green-\d+|sky-\d+|blue-\d+|indigo-\d+|purple-\d+|orange-\d+|\[#[0-9A-Fa-f]{6}\])(?:\/\d+)?)(?![\w/-])/g;
const tokens = new Set();
for (const file of walk(SRC)) {
  for (const m of readFileSync(file, 'utf8').matchAll(TOKEN)) tokens.add(m[1]);
}

// Base utilities first, variants after, so a hover rule wins over its base.
const sorted = [...tokens].sort((a, b) => a.split(':').length - b.split(':').length || a.localeCompare(b));
const rules = sorted.map(ruleFor).filter(Boolean);
writeFileSync(OUT, `/* Generated by scripts/gen-light-theme.mjs — do not edit by hand. */\n${rules.join('\n')}\n`);
console.log(`[light theme] ${rules.length} class rules from ${tokens.size} color classes`);
