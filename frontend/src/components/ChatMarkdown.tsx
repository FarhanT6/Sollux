import { Fragment, type ReactNode } from 'react';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ReferenceLine } from 'recharts';

/**
 * The assistant's answers, drawn: Markdown (headings, bold, italics, inline
 * code, bullet and numbered lists, tables, links) and its ```chart blocks —
 * {"type":"bar"|"line","title","unit","labels":[…],"series":[{"name","values":[…]}]}.
 * A small renderer of the subset the assistant is told to use; anything else
 * shows as the text it is.
 */

const SERIES = ['#F5A623', '#3b82f6', '#34c759', '#af52de', '#ff6b6b'];

interface ChartSpec { type?: 'bar' | 'line'; title?: string; unit?: string; labels: string[]; series: { name: string; values: (number | null)[] }[] }

function parseChart(src: string): ChartSpec | null {
  try {
    const c = JSON.parse(src);
    if (!Array.isArray(c?.labels) || !Array.isArray(c?.series) || !c.series.length) return null;
    return c as ChartSpec;
  } catch { return null; }
}

function fmtValue(v: number, unit?: string) {
  if (unit === '$') return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 })}`;
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}${unit ? ` ${unit}` : ''}`;
}

function Chart({ spec }: { spec: ChartSpec }) {
  const data = spec.labels.map((label, i) => ({ label, ...Object.fromEntries(spec.series.map(s => [s.name, s.values[i] ?? null])) }));
  const hasNegative = spec.series.some(s => s.values.some(v => (v ?? 0) < 0));
  const axis = { stroke: '#6b7280', fontSize: 11 };
  const common = (
    <>
      <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
      <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
      <YAxis tick={axis} tickLine={false} axisLine={false} width={56} tickFormatter={v => (spec.unit === '$' ? fmtValue(Number(v), '$') : Number(v).toLocaleString('en-US', { notation: 'compact' }))} />
      <Tooltip formatter={(v: any) => fmtValue(Number(v), spec.unit)} contentStyle={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.1)', fontSize: 12 }} />
      {spec.series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
      {hasNegative && <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />}
    </>
  );
  return (
    <div className="my-3 rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
      {spec.title && <p className="text-xs font-semibold text-gray-300 mb-2">{spec.title}{spec.unit && spec.unit !== '$' ? <span className="font-normal text-gray-500"> · {spec.unit}</span> : null}</p>}
      <div style={{ width: '100%', height: 220 }}>
        <ResponsiveContainer>
          {spec.type === 'line' ? (
            <LineChart data={data}>{common}{spec.series.map((s, i) => <Line key={s.name} dataKey={s.name} stroke={SERIES[i % SERIES.length]} strokeWidth={2} dot={{ r: 3 }} />)}</LineChart>
          ) : (
            <BarChart data={data}>{common}{spec.series.map((s, i) => <Bar key={s.name} dataKey={s.name} fill={SERIES[i % SERIES.length]} radius={[3, 3, 0, 0]} />)}</BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Bold, italics, inline code and links within one line. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*[^*\s][^*]*\*)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={k++} className="text-white">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k++} className="px-1 rounded bg-white/10 text-xs">{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) { const mm = t.match(/^\[([^\]]+)\]\((.+)\)$/)!; out.push(<a key={k++} href={mm[2]} target="_blank" rel="noreferrer" className="text-amber-400 hover:text-amber-300 underline">{mm[1]}</a>); }
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

export default function ChatMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    // ```chart (or any fenced block)
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const spec = fence[1] === 'chart' ? parseChart(body.join('\n')) : null;
      blocks.push(spec ? <Chart key={k++} spec={spec} /> : <pre key={k++} className="my-2 p-2 rounded bg-white/5 text-xs overflow-x-auto">{body.join('\n')}</pre>);
      continue;
    }
    // A table: header row, separator, rows.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={k++} className="my-2 overflow-x-auto">
          <table className="text-xs w-full">
            <thead><tr>{head.map((h, j) => <th key={j} className={`py-1.5 pr-3 font-semibold text-gray-300 border-b border-white/10 ${j > 0 ? 'text-right' : 'text-left'}`}>{inline(h)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j} className={`py-1.5 pr-3 border-b border-white/5 ${j > 0 ? 'text-right' : ''}`}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocks.push(<p key={k++} className={`font-semibold text-white ${h[1].length <= 2 ? 'text-base mt-3' : 'text-sm mt-2'} mb-1`}>{inline(h[2])}</p>); i++; continue; }
    // Lists, bulleted or numbered, as one block.
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const L = ordered ? 'ol' : 'ul';
      blocks.push(<L key={k++} className={`my-1.5 pl-5 space-y-0.5 ${ordered ? 'list-decimal' : 'list-disc'}`}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</L>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    // A paragraph: consecutive plain lines.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^\s*([-*•]|\d+[.)])\s+|^\s*\|.*\|\s*$/.test(lines[i])) para.push(lines[i++]);
    // A line that looks like a table row but is not a table stands as text.
    if (!para.length) para.push(lines[i++]);
    blocks.push(<p key={k++} className="my-1.5">{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p)}</Fragment>)}</p>);
  }
  return <div className="text-sm leading-relaxed">{blocks}</div>;
}
