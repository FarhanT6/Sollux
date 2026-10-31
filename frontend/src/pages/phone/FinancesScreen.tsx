import { Navigate, useSearchParams } from 'react-router-dom';
import { Screen, Section, Row } from '../../ios';
import { FINANCE_SECTIONS, resolveFinance, ViewSwitch, billsRedirect, rentRedirect } from '../FinancesPage';

const ICON: Record<string, { bg: string; d: string }> = {
  overview: { bg: '#34c759', d: 'M4 19V9M10 19V5M16 19v-7M22 19H2' },
  costs: { bg: '#ff375f', d: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6' },
  loans: { bg: '#0a84ff', d: 'M3 10l9-6 9 6M5 10v10h14V10M9 20v-6h6v6' },
  income: { bg: '#30b0c7', d: 'M12 4v12M6 10l6 6 6-6M4 20h16' },
};
const glyph = (d: string) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/**
 * Finances on a phone: an index of the sections, grouped, each opening as
 * its own screen with a back button. Same ?tab= links as the desktop tabs.
 */
export default function FinancesScreen() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab');
  if (tab === 'personal') return <Navigate to="/personal?tab=expenses" replace />;
  const toBills = billsRedirect(tab, params.get('view')) ?? rentRedirect(tab, params.get('view'));
  if (toBills) return <Navigate to={toBills} replace />;
  const { section, view } = resolveFinance(tab, params.get('view'));

  if (section && view) {
    return (
      <Screen title={section.label} back="/finances" backLabel="Finances" largeTitle={false}>
        <ViewSwitch views={section.views} value={view.key} onChange={v => setParams({ tab: section.key, view: v }, { replace: true })} />
        <p className="ios-muted" style={{ fontSize: 13, margin: '4px 4px 16px' }}>{view.subtitle}</p>
        <div className="ios-embedded">{view.render()}</div>
      </Screen>
    );
  }

  return (
    <Screen title="Finances">
      <Section>
        {FINANCE_SECTIONS.map(s => (
          <Row key={s.key} to={`/finances?tab=${s.key}`} title={s.label} subtitle={s.subtitle}
            icon={{ bg: ICON[s.key]?.bg ?? '#8e8e93', glyph: glyph(ICON[s.key]?.d ?? 'M12 12h.01') }} />
        ))}
      </Section>
    </Screen>
  );
}
