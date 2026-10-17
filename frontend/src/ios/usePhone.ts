import { useEffect, useState } from 'react';

/**
 * Phone layout: a touch screen under 768px wide (the iOS app, phones), or
 * any window under 600px. A computer (mouse or trackpad) keeps the desktop
 * layout down to 600px, so a narrowed browser window is not mistaken for a
 * phone. Tailwind's md breakpoint (tailwind.config.js) and the CSS use the
 * same rule; change all three together.
 */
export const PHONE_QUERY = '(max-width: 599px), (max-width: 767px) and (not (pointer: fine))';
const QUERY = PHONE_QUERY;

export function isPhoneNow(): boolean {
  try { return window.matchMedia(QUERY).matches; } catch { return false; }
}

export function usePhone(): boolean {
  const [phone, setPhone] = useState(isPhoneNow);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}
