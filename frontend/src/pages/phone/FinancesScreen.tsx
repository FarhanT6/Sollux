import { Navigate, useSearchParams } from 'react-router-dom';
import { Screen, Section, Row } from '../../ios';
import { FINANCE_SECTIONS } from '../FinancesPage';

const ICON: Record<string, { bg: string; d: string }> = {
  pnl: { bg: '#34c759', d: 'M4 19V9M10 19V5M16 19v-7M22 19H2' },
  cashflow: { bg: '#30b0c7', d: 'M3 12h4l3-8 4 16 3-8h4' },
  budget: { bg: '#5e5ce6', d: 'M12 3v9l6 6M12 3a9 9 0 1 0 9 9' },
  loans: { bg: '#0a84ff', d: 'M3 10l9-6 9 6M5 10v10h14V10M9 20v-6h6v6' },
  'loan-payments': { bg: '#64d2ff', d: 'M3 5h18v14H3zM3 9h18M7 15h4' },
  incoming: { bg: '#34c759', d: 'M12 4v12M6 10l6 6 6-6M4 20h16' },
  outgoing: { bg: '#ff9f0a', d: 'M12 20V8M6 14l6-6 6 6M4 4h16' },
  reconciliation: { bg: '#a2845e', d: 'M4 7h16M4 12h16M4 17h10M18 15l2 2 3-4' },
  expenses: { bg: '#ff375f', d: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6' },
  fees: { bg: '#bf5af2', d: 'M7 17L17 7M8 8h.01M16 16h.01' },
  'utility-payments': { bg: '#f5a623', d: 'M13 2L4 14h7l-1 8 9-12h-7z' },
  bills: { bg: '#8e8e93', d: 'M6 2h9l5 5v15H6zM14 2v6h6' },
};
const glyph = (d: string) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/**
 * Finances on a phone: an index of the sections, grouped, each opening as
 * its own screen with a back button. Same ?tab= links as the desktop tabs.
 */
export default function FinancesScreen() {
  const [params] = useSearchParams();
  const tab = params.get('tab');
  if (tab === 'personal') return <Navigate to="/personal?tab=expenses" replace />;
  const section = tab ? FINANCE_SECTIONS.find(s => s.key === tab) : null;

  if (section) {
    return (
      <Screen title={section.label} back="/finances" backLabel="Finances" largeTitle={false}>
        <p className="ios-muted" style={{ fontSize: 13, margin: '4px 4px 16px' }}>{section.subtitle}</p>
        <div className="ios-embedded">{section.render()}</div>
      </Screen>
    );
  }

  const groups = [...new Set(FINANCE_SECTIONS.map(s => s.group))];
  return (
    <Screen title="Finances">
      {groups.map(g => (
        <Section key={g} header={g}>
          {FINANCE_SECTIONS.filter(s => s.group === g).map(s => (
            <Row key={s.key} to={`/finances?tab=${s.key}`} title={s.label} subtitle={s.subtitle}
              icon={{ bg: ICON[s.key]?.bg ?? '#8e8e93', glyph: glyph(ICON[s.key]?.d ?? 'M12 12h.01') }} />
          ))}
        </Section>
      ))}
    </Screen>
  );
}
