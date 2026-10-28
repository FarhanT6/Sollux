import { useEffect, useState } from 'react';
import Logo from '../../components/brand/Logo';
import { useUser, useClerk } from '@clerk/clerk-react';
import { Screen, Section, Row, Segmented } from '../../ios';
import { NAV, TAB_BAR } from '../../components/layout/AppLayout';
import { useModules, type ModuleKey } from '../../lib/modules';
import { getDashboardSummary } from '../../api/client';
import { useThemeChoice, type ThemeChoice } from '../../lib/theme';

// Settings-style colored squares for each section.
const COLORS: Record<string, string> = {
  '/bills': '#F5A623', '/import': '#0a84ff', '/portfolio': '#5e5ce6', '/personal': '#30b0c7', '/vault': '#636366',
  '/taxes': '#34c759', '/insurance': '#5e5ce6', '/operating-expenses': '#30b0c7', '/compliance': '#ff9f0a', '/projects': '#a2845e', '/operations': '#64d2ff',
  '/legal': '#8e8e93', '/insights': '#ff375f', '/repairs': '#ff9500',
};

/** Everything that is not in the tab bar, plus the account. */
export default function MoreScreen() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [theme, setTheme] = useThemeChoice();
  const [unread, setUnread] = useState(0);
  useEffect(() => { getDashboardSummary().then(s => setUnread(s.unreadInsights)).catch(() => {}); }, []);

  const initials = `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}` || '·';
  // Pages not on the tab bar, from the modules this account has turned on.
  const { shown } = useModules();
  const items = NAV.filter(n => !TAB_BAR.includes(n.to) && shown(n.to, (n as { module?: ModuleKey }).module));

  return (
    <Screen title="More">
      <Section>
        <Row
          to="/settings"
          icon={{ bg: 'var(--ios-tint)', glyph: <span style={{ fontWeight: 600, fontSize: 13 }}>{initials}</span> }}
          title={user?.fullName || 'Account'}
          subtitle={user?.primaryEmailAddress?.emailAddress ?? 'Settings, sign-in, subscription'}
        />
      </Section>

      <Section header="Manage">
        {items.map(n => (
          <Row key={n.to} to={n.to} title={n.label}
            icon={{ bg: COLORS[n.to] ?? '#8e8e93', glyph: n.icon(17) }}
            value={n.to === '/insights' && unread > 0 ? <span className="ios-badge red">{unread}</span> : undefined}
          />
        ))}
      </Section>

      <Section header="Appearance">
        <div style={{ padding: '12px 16px 0' }}>
          <Segmented<ThemeChoice> label="Theme" value={theme} onChange={setTheme}
            options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'Automatic' }]} />
        </div>
      </Section>

      <Section>
        <Row to="/settings" title="Settings" icon={{ bg: '#8e8e93', glyph: <Gear /> }} />
        <Row title="Sign Out" destructive chevron={false} onClick={() => { if (confirm('Sign out of Sollux?')) void signOut(); }} />
      </Section>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 24px', opacity: 0.85 }}><Logo size={30} tagline /></div>
    </Screen>
  );
}

const Gear = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
