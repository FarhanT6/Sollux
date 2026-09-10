import { useNavigate, Link } from 'react-router-dom';
import type { ReactNode, MouseEvent } from 'react';

/**
 * "Back" that goes back. These links used to be hard-wired to a parent
 * page, so from Budget → tenant → Back you landed on the tenant list, not
 * the Budget table you came from. If this tab has an earlier in-app page,
 * go there; if the page was opened cold (a pasted link, a new tab), fall
 * back to the parent so the link never dead-ends.
 */
export default function BackLink({ fallback, className, style, children }: {
  fallback: string; className?: string; style?: React.CSSProperties; children: ReactNode;
}) {
  const navigate = useNavigate();
  const canGoBack = typeof window !== 'undefined' && Number((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let "open in new tab" work
    if (!canGoBack) return;
    e.preventDefault();
    navigate(-1);
  };
  return <Link to={fallback} onClick={onClick} className={className} style={style}>{children}</Link>;
}
