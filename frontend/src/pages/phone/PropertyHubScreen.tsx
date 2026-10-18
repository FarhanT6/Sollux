import { useState, type ReactNode } from 'react';
import { Screen, Section, Row, Sheet, BarButton, Icon } from '../../ios';
import type { Property } from '../../types';
import { PROPERTY_TYPE_LABELS } from '../../types';
import { fmtMoney } from '../../lib/money';

// Whole dollars: a property's figures are large, and cents only crowd them.
const money0 = (n: number) => fmtMoney(n).replace(/\.\d\d$/, '');

/** What each section of a property is, for the index. */
const SECTIONS: Record<string, { bg: string; glyph: string; sub: string }> = {
  Units:       { bg: '#5e5ce6', glyph: '▦', sub: 'Units, beds and baths' },
  Tenants:     { bg: '#30b0c7', glyph: '◉', sub: 'Leases, rent and payments' },
  Turnover:    { bg: '#64d2ff', glyph: '↻', sub: 'Move-ins, move-outs and vacancy' },
  Loans:       { bg: '#0a84ff', glyph: '$', sub: 'Mortgages and balances' },
  Expenses:    { bg: '#ff9f0a', glyph: '−', sub: 'Repairs, services and supplies' },
  Insurance:   { bg: '#32d74b', glyph: '⛨', sub: 'Policies and renewals' },
  Maintenance: { bg: '#ac8e68', glyph: '⚒', sub: 'Improvements and repairs' },
  Tax:         { bg: '#8e8e93', glyph: '%', sub: 'Assessments and property tax' },
  Compliance:  { bg: '#30d158', glyph: '✓', sub: 'Inspections, permits and licences' },
  Legal:       { bg: '#ff453a', glyph: '§', sub: 'Notices and cases' },
  Documents:   { bg: '#bf5af2', glyph: '❐', sub: 'Leases, deeds and files' },
};

/**
 * A property on a phone. The index is the property at a glance, its sections
 * as a list, and the overview below; a section opens as its own screen with
 * Back to the property. PropertyHubPage owns the data and the sections'
 * content; this decides only how a phone lays them out.
 */
export default function PropertyHubScreen({ property, tab, tabs, stats, onEdit, onExport, content, modals }: {
  property: Property;
  tab: string;
  tabs: readonly string[];
  stats: { rent: number; arrears: number; equity: number; occupancy: number | null; units: number };
  onEdit: () => void;
  onExport: (k: 'rentroll' | 't12') => void;
  content: ReactNode;
  modals: ReactNode;
}) {
  const [actions, setActions] = useState(false);
  const name = property.nickname || property.address;
  const base = `/portfolio/${property.id}`;

  if (tab !== 'Overview') return (
    <Screen title={tab} back={base} backLabel={name} largeTitle={false}>
      <div className="ios-embedded">{content}</div>
      {modals}
    </Screen>
  );

  return (
    <Screen title={name} back
      subtitle={`${property.city}, ${property.state} · ${PROPERTY_TYPE_LABELS[property.type] ?? property.type}${property.status !== 'ACTIVE' ? ` · ${property.status}` : ''}`}
      right={<BarButton label="Property actions" onClick={() => setActions(true)}><Icon.Ellipsis /></BarButton>}>

      <div className="ios-card" style={{ marginBottom: 12 }}>
        <div className="ios-hero-label">Rent per month</div>
        <div className="ios-hero-value">{money0(stats.rent)}</div>
        <div className="ios-hero-sub">
          {stats.arrears > 0 ? <span className="ios-red">{money0(stats.arrears)} in arrears</span> : 'No arrears'}
        </div>
      </div>
      <div className="ios-chips" style={{ marginBottom: 24 }}>
        <div className="ios-chip"><div className="k">Value</div><div className="v">{property.estimatedValue ? money0(Number(property.estimatedValue)) : '—'}</div></div>
        <div className="ios-chip"><div className="k">Equity</div><div className="v ios-green">{stats.equity > 0 ? money0(stats.equity) : '—'}</div></div>
        <div className="ios-chip"><div className="k">Occupied</div>
          <div className={`v ${stats.occupancy == null ? '' : stats.occupancy === 100 ? 'ios-green' : stats.occupancy < 75 ? 'ios-red' : 'ios-tint'}`}>{stats.occupancy == null ? '—' : `${stats.occupancy}%`}</div></div>
        <div className="ios-chip"><div className="k">Units</div><div className="v">{stats.units}</div></div>
      </div>

      <Section>
        {tabs.filter(t => t !== 'Overview').map(t => {
          const meta = SECTIONS[t] ?? { bg: '#8e8e93', glyph: '•', sub: '' };
          return (
            <Row key={t} to={`${base}?tab=${encodeURIComponent(t)}`} title={t} subtitle={meta.sub}
              icon={{ bg: meta.bg, glyph: <span style={{ fontWeight: 700, fontSize: 14 }}>{meta.glyph}</span> }} />
          );
        })}
      </Section>

      <div className="ios-embedded">{content}</div>

      <Sheet open={actions} onClose={() => setActions(false)} title={name} left={null}
        right={{ label: 'Done', onClick: () => setActions(false) }}>
        <Section>
          <Row title="Edit property" onClick={() => { setActions(false); onEdit(); }} />
        </Section>
        <Section header="Export" footer="Spreadsheets for lenders, buyers and your accountant.">
          <Row title="Rent roll" subtitle="Units, leases and rent" onClick={() => { setActions(false); onExport('rentroll'); }} />
          <Row title="T-12 operating statement" subtitle="The last twelve months" onClick={() => { setActions(false); onExport('t12'); }} />
        </Section>
      </Sheet>

      {modals}
    </Screen>
  );
}
