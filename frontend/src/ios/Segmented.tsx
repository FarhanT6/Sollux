import { tap } from '../lib/native';

/** iOS segmented control: a sliding thumb behind 2–5 equal segments. */
export default function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  const i = Math.max(0, options.findIndex(o => o.value === value));
  const w = 100 / options.length;
  return (
    <div className="ios-segmented" role="tablist" aria-label={label}>
      <span className="thumb" style={{ left: 2, width: `calc(${w}% - ${4 / options.length}px)`, transform: `translateX(calc(${i * 100}% + ${i * (4 / options.length)}px))` }} />
      {options.map(o => (
        <button key={o.value} role="tab" aria-selected={o.value === value} onClick={() => { if (o.value !== value) { void tap(); onChange(o.value); } }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
