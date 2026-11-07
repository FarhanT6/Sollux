/**
 * A drag is not a click. Popups and side panels close when their dark
 * backdrop is clicked; a press that starts inside the panel (highlighting a
 * tenant's name to copy it) and is let go past its edge is reported by the
 * browser as a click on the backdrop — the nearest element both ends share —
 * and the panel closed mid-highlight. Some browsers and trackpads do this
 * more readily than others, so it happened on one person's computer and not
 * another's.
 *
 * One rule for the whole app: a click that ends on a different element than
 * the press began on, after the pointer moved, is a drag, and is dropped before any handler sees it. An ordinary click (press
 * and release on the same spot) is untouched.
 */
let down: { target: EventTarget | null; x: number; y: number } | null = null;

export function installDragSafeClicks(): void {
  if (typeof document === 'undefined') return;
  document.addEventListener('pointerdown', e => { down = { target: e.target, x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener('click', e => {
    const d = down;
    down = null;
    if (!d || d.target === e.target) return;
    // Keyboard "clicks" (Enter on a button) have no pointer position.
    if (e.detail === 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}
