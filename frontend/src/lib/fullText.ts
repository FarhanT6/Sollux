/**
 * Cut-off text, anywhere in the app, can be read in full: hovering text that
 * ends in "…" (Tailwind's truncate or line-clamp, or any text-overflow:
 * ellipsis) shows all of it as a tooltip, and so does a select or input too
 * narrow for its value. On a touch screen, which has no hover, tapping
 * cut-off text unfolds it in place; tapping again folds it. Links, buttons
 * and fields keep their own taps.
 *
 * One listener on the document rather than a title on every element, so
 * new pages get it without anyone remembering to.
 */

const MARK = 'data-fulltext';      // the title is ours (kept up to date), not the page's
const UNFOLD = 'sollux-unfold';

function cutOff(el: HTMLElement): boolean {
  if (el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1) {
    const cs = getComputedStyle(el);
    return cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== '' && cs.webkitLineClamp != null || /\b(truncate|line-clamp-\d)\b/.test(el.className);
  }
  return false;
}

/** The nearest element (from the target up a few levels) whose text is cut off. */
function cutOffAncestor(start: Element | null): HTMLElement | null {
  let el = start as HTMLElement | null;
  for (let i = 0; el && i < 4; i++, el = el.parentElement) {
    if (el instanceof HTMLElement && (el.classList.contains(UNFOLD) || cutOff(el))) return el;
  }
  return null;
}

function fieldText(el: Element): string | null {
  if (el instanceof HTMLSelectElement) {
    const text = el.selectedOptions[0]?.text ?? '';
    // A select shows its option in a box; a long one is cut, so say it whole.
    return text.length > 24 ? text : null;
  }
  if (el instanceof HTMLInputElement && /^(text|search|email|url|)$/.test(el.type)) {
    return el.scrollWidth - el.clientWidth > 1 ? el.value : null;
  }
  return null;
}

function setTitle(el: Element, text: string) {
  const own = el.getAttribute('title');
  if (own && !el.hasAttribute(MARK)) return;    // the page gave its own tooltip
  if (own !== text) { el.setAttribute('title', text); el.setAttribute(MARK, ''); }
}

export function installFullText() {
  if (typeof document === 'undefined') return;

  document.addEventListener('mouseover', e => {
    const target = e.target as Element | null;
    if (!target) return;
    const field = target.closest('select, input');
    if (field) { const t = fieldText(field); if (t) setTitle(field, t); return; }
    const el = cutOffAncestor(target);
    if (el) {
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) setTitle(el, text);
    }
  }, { passive: true });

  // Touch: a tap unfolds cut-off text that is not itself something to tap.
  const touch = window.matchMedia?.('(hover: none)').matches;
  if (touch) {
    document.addEventListener('click', e => {
      const target = e.target as Element | null;
      if (!target || target.closest('a, button, select, input, textarea, label, [role="button"], [role="option"], [onclick]')) return;
      const el = cutOffAncestor(target);
      if (el) el.classList.toggle(UNFOLD);
    });
  }
}
