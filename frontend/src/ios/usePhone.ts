import { useEffect, useState } from 'react';

/** Phone layout: the iOS app, or any screen under 768px wide. */
const QUERY = '(max-width: 767px)';

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
