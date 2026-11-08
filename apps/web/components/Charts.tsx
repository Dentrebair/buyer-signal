"use client";
// Charts for the Health dashboard (agreed 2026-11-08), drawn as SVG in the app's own tokens.
// Rules from the dataviz method: 2px lines, columns <= 24px with a 4px rounded top and a 2px
// gap between stacked parts, hairline solid grid, one axis, a legend for two or more series,
// text in text tokens (never the series colour), a tooltip on hover and keyboard focus, and a
// table view for every chart. Colours: --viz-1..3, validated for colour-blind readers in both modes.
import { useEffect, useId, useRef, useState } from "react";

export type Fmt = "int" | "usd" | "pct";
export const fmt = (v: number, f: Fmt) =>
  f === "usd" ? (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(v === 0 ? 2 : 4)}`) : f === "pct" ? `${Math.round(v * 100)}%` : Math.round(v).toLocaleString("en-US");

export interface Series {
  key: string;
  label: string;
  values: (number | null)[];
  slot: 1 | 2 | 3;
}

const H = 180; // plot height
const PAD = { top: 12, right: 12, bottom: 24, left: 48 };

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// Clean ticks: 0 and at most 4 steps of 1, 2, 2.5 or 5 × 10^n, ending at or above the maximum.
function ticks(max: number, f: Fmt): number[] {
  if (f === "pct") return [0, 0.5, 1];
  if (max <= 0) return [0];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step - 1e-9) + 1 }, (_, i) => i * step);
}
const axis = (v: number, f: Fmt, step: number) => (f === "usd" ? `$${v.toFixed(step >= 0.01 ? 2 : 4)}` : fmt(v, f));

const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function Legend({ series, kind }: { series: Series[]; kind: "rect" | "line" }) {
  if (series.length < 2) return null;
  return (
    <ul className="viz-legend">
      {series.map((s) => (
        <li key={s.key}>
          <span className={`viz-key viz-key-${kind}`} style={{ background: `var(--viz-${s.slot})` }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function Tooltip({ x, w, title, rows, f, total }: { x: number; w: number; title: string; rows: { s: Series; v: number | null }[]; f: Fmt; total?: number }) {
  const left = Math.min(Math.max(x - 80, 0), Math.max(w - 160, 0));
  return (
    <div className="viz-tip" style={{ left }} role="status">
      <span className="viz-tip-title">{title}</span>
      {rows.map(({ s, v }) => (
        <span key={s.key} className="viz-tip-row">
          <span className="viz-tip-key" style={{ background: `var(--viz-${s.slot})` }} aria-hidden />
          <strong className="num">{v === null ? "—" : fmt(v, f)}</strong> {s.label}
        </span>
      ))}
      {total !== undefined && (
        <span className="viz-tip-row viz-tip-total">
          <strong className="num">{fmt(total, f)}</strong> in all
        </span>
      )}
    </div>
  );
}

function TableView({ x, series, f, xLabel }: { x: string[]; series: Series[]; f: Fmt; xLabel: string }) {
  return (
    <details className="viz-table">
      <summary>Show as a table</summary>
      <div className="runs-wrap">
        <table className="runs">
          <thead>
            <tr>
              <th scope="col">{xLabel}</th>
              {series.map((s) => (
                <th key={s.key} scope="col" className="r">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {x.map((d, i) => (
              <tr key={d}>
                <td>{d}</td>
                {series.map((s) => (
                  <td key={s.key} className="r num">
                    {s.values[i] === null ? "—" : fmt(s.values[i]!, f)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// Daily columns; two series stack (each part keeps a 2px gap above the one below).
export function ColumnChart({ title, days, series, f }: { title: string; days: string[]; series: Series[]; f: Fmt }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const totals = days.map((_, i) => series.reduce((n, s) => n + (s.values[i] ?? 0), 0));
  const t = ticks(Math.max(...totals, 0), f);
  const top = t[t.length - 1]! || 1;
  const pw = Math.max(w - PAD.left - PAD.right, 0);
  const band = days.length ? pw / days.length : 0;
  const bw = Math.min(24, Math.max(2, band - 2));
  const y = (v: number) => PAD.top + H - (v / top) * H;
  const labelled = [0, Math.floor((days.length - 1) / 2), days.length - 1];
  const move = (dx: number) => setActive((a) => Math.min(Math.max((a ?? days.length - 1) + dx, 0), days.length - 1));
  return (
    <figure className="viz">
      <figcaption className="viz-title" id={id}>
        {title}
      </figcaption>
      <Legend series={series} kind="rect" />
      <div ref={ref} className="viz-plot">
        {w > 0 && (
          <svg
            width={w}
            height={H + PAD.top + PAD.bottom}
            role="img"
            aria-labelledby={id}
            tabIndex={0}
            onKeyDown={(e) => (e.key === "ArrowLeft" ? move(-1) : e.key === "ArrowRight" ? move(1) : e.key === "Escape" ? setActive(null) : null)}
            onFocus={() => setActive((a) => a ?? days.length - 1)}
            onBlur={() => setActive(null)}
            onPointerLeave={() => setActive(null)}
          >
            {t.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={PAD.left + pw} y1={y(v)} y2={y(v)} className="viz-grid" />
                <text x={PAD.left - 6} y={y(v)} className="viz-axis" textAnchor="end" dominantBaseline="middle">
                  {axis(v, f, t[1] ?? 1)}
                </text>
              </g>
            ))}
            {days.map((d, i) => {
              const cx = PAD.left + band * i + band / 2;
              let base = 0;
              return (
                <g key={d} className={active === i ? "is-active" : undefined}>
                  {series.map((s, k) => {
                    const v = s.values[i] ?? 0;
                    if (v <= 0) return null;
                    const y0 = y(base);
                    base += v;
                    const gap = k > 0 ? 2 : 0; // surface gap above the part below
                    const h = Math.max(y0 - y(base) - gap, 1);
                    const r = Math.min(4, bw / 2, h);
                    const x0 = cx - bw / 2;
                    const yt = y0 - gap - h;
                    // Rounded top only: the data end is round, the baseline end square.
                    return (
                      <path
                        key={s.key}
                        d={`M${x0},${y0 - gap} V${yt + r} Q${x0},${yt} ${x0 + r},${yt} H${x0 + bw - r} Q${x0 + bw},${yt} ${x0 + bw},${yt + r} V${y0 - gap} Z`}
                        fill={`var(--viz-${s.slot})`}
                      />
                    );
                  })}
                  <rect x={PAD.left + band * i} y={PAD.top} width={band} height={H} fill="transparent" onPointerMove={() => setActive(i)} />
                  {labelled.includes(i) && (
                    <text x={cx} y={PAD.top + H + 16} className="viz-axis" textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}>
                      {dayLabel(d)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {active !== null && (
          <Tooltip
            x={PAD.left + band * active + band / 2}
            w={w}
            title={dayLabel(days[active]!)}
            rows={series.map((s) => ({ s, v: s.values[active] ?? 0 }))}
            f={f}
            total={series.length > 1 ? totals[active] : undefined}
          />
        )}
      </div>
      <TableView x={days.map(dayLabel)} series={series} f={f} xLabel="Day" />
    </figure>
  );
}

// A line per series over points that are not evenly spaced in time (eval runs); the crosshair
// snaps to the nearest point and the tooltip lists every series there.
export function LineChart({ title, x, series, f }: { title: string; x: string[]; series: Series[]; f: Fmt }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const t = ticks(Math.max(...all, 0), f);
  const top = t[t.length - 1]! || 1;
  const pw = Math.max(w - PAD.left - PAD.right - 96, 0); // room for end labels
  const px = (i: number) => PAD.left + (x.length > 1 ? (pw * i) / (x.length - 1) : pw / 2);
  const y = (v: number) => PAD.top + H - (v / top) * H;
  const last = x.length - 1;
  // End labels only when they sit apart; otherwise the legend and tooltip carry identity.
  const ends = series.map((s) => s.values[last]).filter((v): v is number => v !== null).map(y).sort((a, b) => a - b);
  const apart = ends.every((v, i) => i === 0 || v - ends[i - 1]! >= 14);
  const move = (dx: number) => setActive((a) => Math.min(Math.max((a ?? last) + dx, 0), last));
  return (
    <figure className="viz">
      <figcaption className="viz-title" id={id}>
        {title}
      </figcaption>
      <Legend series={series} kind="line" />
      <div ref={ref} className="viz-plot">
        {w > 0 && (
          <svg
            width={w}
            height={H + PAD.top + PAD.bottom}
            role="img"
            aria-labelledby={id}
            tabIndex={0}
            onKeyDown={(e) => (e.key === "ArrowLeft" ? move(-1) : e.key === "ArrowRight" ? move(1) : e.key === "Escape" ? setActive(null) : null)}
            onFocus={() => setActive((a) => a ?? last)}
            onBlur={() => setActive(null)}
            onPointerLeave={() => setActive(null)}
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const mx = e.clientX - r.left;
              let best = 0;
              for (let i = 1; i < x.length; i++) if (Math.abs(px(i) - mx) < Math.abs(px(best) - mx)) best = i;
              setActive(best);
            }}
          >
            {t.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={PAD.left + pw} y1={y(v)} y2={y(v)} className="viz-grid" />
                <text x={PAD.left - 6} y={y(v)} className="viz-axis" textAnchor="end" dominantBaseline="middle">
                  {axis(v, f, t[1] ?? 1)}
                </text>
              </g>
            ))}
            {active !== null && <line x1={px(active)} x2={px(active)} y1={PAD.top} y2={PAD.top + H} className="viz-cross" />}
            {series.map((s) => {
              const pts = s.values.map((v, i) => (v === null ? null : `${px(i)},${y(v)}`)).filter(Boolean);
              const end = s.values[last];
              return (
                <g key={s.key}>
                  <polyline points={pts.join(" ")} fill="none" stroke={`var(--viz-${s.slot})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {s.values.map((v, i) =>
                    v === null || (i !== last && i !== active) ? null : <circle key={i} cx={px(i)} cy={y(v)} r={4} fill={`var(--viz-${s.slot})`} className="viz-dot" />,
                  )}
                  {apart && end !== null && end !== undefined && (
                    <text x={px(last) + 8} y={y(end)} className="viz-end" dominantBaseline="middle">
                      {s.label} {fmt(end, f)}
                    </text>
                  )}
                </g>
              );
            })}
            {[0, last].filter((i, k, a) => a.indexOf(i) === k).map((i) => (
              <text key={i} x={px(i)} y={PAD.top + H + 16} className="viz-axis" textAnchor={i === 0 && last > 0 ? "start" : "end"}>
                {x[i]}
              </text>
            ))}
          </svg>
        )}
        {active !== null && <Tooltip x={px(active)} w={w} title={x[active]!} rows={series.map((s) => ({ s, v: s.values[active] ?? null }))} f={f} />}
      </div>
      <TableView x={x} series={series} f={f} xLabel="Run" />
    </figure>
  );
}
