import { useCallback, useEffect, useMemo, useState } from 'react';
import { Screen, Section, Row, Segmented, BarButton, Icon, categoryIcon } from '../../ios';
import { getProperties } from '../../api/client';
import type { Property } from '../../types';
import { accountStatus } from '../../lib/accountStatus';
import { fmtMoney } from '../../lib/money';
import AddPropertyModal from '../../components/property/AddPropertyModal';

type Filter = 'all' | 'open' | 'late';
const TONE: Record<string, string> = { green: 'ios-green', red: 'ios-red', amber: 'ios-tint', blue: '', gray: 'ios-muted' };

/**
 * Utilities on a phone: every property's accounts as one list, newest bill
 * and where it stands (the same rule as the desktop cards), searchable and
 * filtered to what is still open or late.
 */
export default function UtilitiesScreen() {
  const [properties, setProperties] = useState<Property[] | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => getProperties().then(setProperties).catch(() => setProperties([])), []);
  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (properties ?? []).map(p => {
      const label = p.nickname || p.address;
      const rows = (p.utilityAccounts ?? []).filter(a => a.isActive !== false).map(a => ({ a, st: accountStatus(a as any) }));
      const shown = rows.filter(({ a, st }) => {
        if (filter === 'open' && (st.isPaid || !st.latest)) return false;
        if (filter === 'late' && !st.isPastDue) return false;
        if (!needle) return true;
        return [label, p.address, p.city, a.providerName].some(s => s?.toLowerCase().includes(needle));
      });
      const open = rows.reduce((s, r) => s + (r.st.isPaid ? 0 : (r.st.amount ?? 0) + r.st.pastDue), 0);
      return { p, label, shown, open, total: rows.length };
    }).filter(g => g.shown.length > 0 || (!needle && filter === 'all'));
  }, [properties, q, filter]);

  const accountCount = (properties ?? []).reduce((s, p) => s + (p.utilityAccounts?.length ?? 0), 0);

  return (
    <Screen title="Utilities" subtitle={properties ? `${properties.length} properties · ${accountCount} accounts` : undefined}
      onRefresh={load} right={<BarButton label="Add property" onClick={() => setAdding(true)}><Icon.Plus /></BarButton>}>
      <div className="ios-search">
        <Icon.Search />
        <input type="search" placeholder="Search properties or providers" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <Segmented<Filter> label="Show" value={filter} onChange={setFilter}
        options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Unpaid' }, { value: 'late', label: 'Past due' }]} />

      {properties == null && <div className="ios-skeleton" style={{ height: 180 }} />}
      {properties != null && groups.length === 0 && (
        <div className="ios-empty">
          <h3>{q || filter !== 'all' ? 'Nothing matches' : 'No properties yet'}</h3>
          {q || filter !== 'all' ? 'Try a different search or filter.' : 'Add a property, then its utility accounts.'}
        </div>
      )}

      {groups.map(({ p, label, shown, open, total }) => (
        <Section key={p.id} header={label} action={{ label: 'Property', to: `/properties/${p.id}` }}
          footer={total === 0 ? undefined : open > 0 ? `${fmtMoney(open)} open across ${total} account${total === 1 ? '' : 's'}.` : `All ${total} paid.`}>
          {total === 0 && <Row title="No utility accounts" subtitle="Add one from the property" to={`/properties/${p.id}`} />}
          {shown.map(({ a, st }) => (
            <Row key={a.id} to={`/properties/${p.id}/utilities/${a.id}`}
              icon={categoryIcon(a.category)} title={a.providerName}
              subtitle={<span className={TONE[st.tone]}>{st.label}{st.pastDue > 0 ? ` · +${fmtMoney(st.pastDue)} past due` : ''}</span>}
              value={st.amount != null ? <span className={st.isPaid ? '' : 'strong'}>{fmtMoney(st.amount)}</span> : '—'}
            />
          ))}
        </Section>
      ))}

      {adding && <AddPropertyModal onClose={() => { setAdding(false); void load(); }} />}
    </Screen>
  );
}
