import { NavLink, useLocation } from 'react-router-dom';
import { usePhone } from '../../ios';

/**
 * The menu has one item per area; an area's other views are tabs across the
 * top of its pages, so related pages read as one place instead of a dozen
 * menu items. Each view keeps its own address, and old links still work.
 */
export const SECTIONS = {
  overview: [
    { to: '/dashboard', label: 'Today' },
    { to: '/insights', label: 'Where you can save' },
  ],
  bills: [
    { to: '/bills', label: 'Bills' },
  ],
  rent: [
    { to: '/portfolio', label: 'Properties' },
    { to: '/tenants', label: 'Tenants & rent' },
    { to: '/repairs', label: 'Repairs' },
    { to: '/legal', label: 'Legal' },
  ],
  money: [
    { to: '/finances', label: 'Finances' },
    { to: '/taxes', label: 'Taxes' },
    { to: '/insurance', label: 'Insurance' },
  ],
  add: [
    { to: '/import', label: 'Import files' },
    { to: '/scan', label: 'Scan mail' },
  ],
  personal: [
    { to: '/personal', label: 'Personal' },
    { to: '/vault', label: 'Vault' },
    { to: '/projects', label: 'Projects' },
  ],
} as const;

export type SectionKey = keyof typeof SECTIONS;

/** Pages that belong to an area without a tab of their own: an account's page is Bills & accounts', a loan's is Money's. */
const ALSO_IN: Partial<Record<SectionKey, string[]>> = {
  bills: ['/properties', '/payments'],
  rent: ['/notices', '/reimbursements', '/compliance'],
  money: ['/loans', '/operating-expenses'],
};

/** The area a path belongs to, for keeping its menu item lit on every view in it. */
export function sectionOf(pathname: string): SectionKey | null {
  const under = (to: string) => pathname === to || pathname.startsWith(`${to}/`);
  for (const [key, views] of Object.entries(SECTIONS) as [SectionKey, readonly { to: string }[]][]) {
    if (views.some(v => under(v.to))) return key;
  }
  for (const [key, prefixes] of Object.entries(ALSO_IN) as [SectionKey, string[]][]) {
    if (prefixes.some(under)) return key;
  }
  return null;
}

export default function Section({ group, children }: { group: SectionKey; children: React.ReactNode }) {
  const phone = usePhone();
  const { pathname } = useLocation();
  // A phone reaches these from More; the strip is for the computer's menu.
  if (phone) return <>{children}</>;
  return (
    <>
      <div className="px-4 md:px-8 pt-4 flex gap-1 flex-wrap" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {SECTIONS[group].map(v => {
          const active = pathname === v.to || pathname.startsWith(`${v.to}/`);
          return (
            <NavLink key={v.to} to={v.to}
              className={`text-sm px-3 py-2 -mb-px border-b-2 transition-colors ${active ? 'border-[#F5A623] text-white font-medium' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
              {v.label}
            </NavLink>
          );
        })}
      </div>
      {children}
    </>
  );
}
