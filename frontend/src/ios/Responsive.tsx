import type { ReactNode } from 'react';
import { usePhone } from './usePhone';

/**
 * One route, two screens: the phone screen under 768px wide (and in the iOS
 * app), the desktop page above. Both read the same API, so a fix to the data
 * reaches both.
 */
export default function Responsive({ phone, desktop }: { phone: ReactNode; desktop: ReactNode }) {
  return <>{usePhone() ? phone : desktop}</>;
}
