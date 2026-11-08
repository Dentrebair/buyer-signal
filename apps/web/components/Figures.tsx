// Figures for the Health dashboard (agreed 2026-11-08): stat tiles and ranked bars. Server-safe
// (no hooks). A tile: label, value, change against the period before (icon + words, coloured by
// whether that change is good), and a daily sparkline in the quiet hue with today in the accent.
import { ArrowDown, ArrowUp, Minus } from "@phosphor-icons/react/ssr";

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 28;
  const max = Math.max(...values, 0) || 1;
  const pts = values.map((v, i) => [(w * i) / (values.length - 1), h - 3 - (v / max) * (h - 6)] as const);
  const [lx, ly] = pts[pts.length - 1]!;
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="spark-line" />
      <circle cx={lx} cy={ly} r={3} className="spark-end" />
    </svg>
  );
}

export function StatTile({
  label,
  value,
  compare,
  spark,
  note,
}: {
  label: string;
  value: string;
  // Against the period before: its value as words ("$0.42"), the relative change (null when
  // there was nothing before), and whether up is good (null: neither, e.g. spend).
  compare?: { period: string; before: string; change: number | null; upIsGood: boolean | null };
  spark?: number[];
  note?: string;
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {compare && <Delta {...compare} />}
      {spark && <Sparkline values={spark} />}
      {note && <span className="kpi-note">{note}</span>}
    </div>
  );
}

function Delta({ period, before, change, upIsGood }: NonNullable<Parameters<typeof StatTile>[0]["compare"]>) {
  if (change === null) return <span className="kpi-delta kpi-flat">Nothing in {period} to compare with</span>;
  const dir = Math.abs(change) < 0.005 ? 0 : change > 0 ? 1 : -1;
  const tone = dir === 0 || upIsGood === null ? "flat" : (dir > 0) === upIsGood ? "good" : "bad";
  const Icon = dir > 0 ? ArrowUp : dir < 0 ? ArrowDown : Minus;
  return (
    <span className={`kpi-delta kpi-${tone}`}>
      <Icon size={13} weight="bold" aria-hidden />
      {dir === 0 ? `Same as ${period} (${before})` : `${Math.round(Math.abs(change) * 100)}% ${dir > 0 ? "higher" : "lower"} than ${period} (${before})`}
    </span>
  );
}

// One whole's parts, largest first, one hue; value and share at each bar's tip.
export function RankedBars({ title, rows, total, empty }: { title: string; rows: { label: string; n: number }[]; total?: number; empty: string }) {
  const max = Math.max(...rows.map((r) => r.n), 0);
  const sum = total ?? rows.reduce((n, r) => n + r.n, 0);
  return (
    <figure className="viz">
      <figcaption className="viz-title">{title}</figcaption>
      {rows.length === 0 || max === 0 ? (
        <p className="muted viz-empty">{empty}</p>
      ) : (
        <ul className="bars">
          {rows.map((r) => (
            <li key={r.label} className="bars-row">
              <span className="bars-label">{r.label}</span>
              <span className="bars-track">
                <span className="bars-fill" style={{ width: `calc((100% - 6.5rem) * ${r.n / max})` }} />
                <span className="bars-value num">
                  {r.n.toLocaleString("en-US")}
                  {sum > 0 && <span className="muted"> {Math.round((r.n / sum) * 100)}%</span>}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
