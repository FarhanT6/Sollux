import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { report } from '../lib/telemetry';
import { previousEntry } from '../ios/routes';

/**
 * An address the app has no page for. It used to redirect to the dashboard
 * without a word, which hid every broken link: the owner landed somewhere
 * unexpected and nothing recorded why. Now it says so, and the bad address
 * and the page that linked to it go to telemetry, where the nightly auditor
 * files them.
 */
export default function NotFoundPage() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    const from = previousEntry();
    report(`No page at ${pathname}${search}${from ? ` (linked from ${from})` : ''}`);
  }, [pathname, search]);
  return (
    <div className="flex flex-col items-center justify-center text-center px-6" style={{ minHeight: '60vh' }}>
      <p className="text-4xl mb-3" aria-hidden="true">🧭</p>
      <h1 className="text-lg font-semibold text-white">This page doesn't exist</h1>
      <p className="text-sm text-gray-400 mt-1 max-w-sm">
        The link may be out of date. It has been reported so it can be fixed.
      </p>
      <Link to="/dashboard" className="btn btn-primary text-sm mt-5">Go to Overview</Link>
    </div>
  );
}
