"use client";
// Run now controls for the Sources page (§10.3).
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Play } from "@phosphor-icons/react";
import { COUNTRIES, SEARCH_TITLES, VERTICALS, VERTICAL_MARKETS, type Country, type VerticalSlug } from "@bs/core/verticals";
import { type RunResult, runJobPosts, runSource } from "@/app/radar/actions.ts";

// Indeed price (§4.1): $0.0001 per post + $0.001 per run start.
const apifyCost = (posts: number) => posts * 0.0001 + 0.001;

function Result({ r }: { r: RunResult | null }) {
  return (
    <p role="status" className={`run-result${r && !r.ok ? " is-error" : ""}`}>
      {r?.message ?? ""}
    </p>
  );
}

export function RunJobPosts({ next }: { next: { vertical: VerticalSlug; country: Country; title: string } | null }) {
  const [open, setOpen] = useState(false);
  const [vertical, setVertical] = useState<VerticalSlug>(next?.vertical ?? "accounting");
  const [country, setCountry] = useState<Country>(next?.country ?? VERTICAL_MARKETS[vertical][0]!);
  const [title, setTitle] = useState(next?.title ?? SEARCH_TITLES[vertical][0]!);
  const [limit, setLimit] = useState(35);
  const [result, setResult] = useState<RunResult | null>(null);
  const [pending, start] = useTransition();

  const pickVertical = (v: VerticalSlug) => {
    setVertical(v);
    if (!VERTICAL_MARKETS[v].includes(country)) setCountry(VERTICAL_MARKETS[v][0]!);
    setTitle(SEARCH_TITLES[v][0]!);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await runJobPosts({ vertical, country, title, limit }).catch((err: Error) => ({ ok: false as const, message: err.message }));
      setResult(r);
      if (r.ok) setOpen(false);
    });
  };

  if (!open)
    return (
      <div className="run">
        <button type="button" className="btn primary" onClick={() => (setOpen(true), setResult(null))}>
          <Play size={14} weight="fill" aria-hidden /> Run now
        </button>
        <Result r={result} />
      </div>
    );
  return (
    <form className="run-form" onSubmit={submit} aria-label="Run job posts now">
      <label className="field">
        Vertical
        <select value={vertical} onChange={(e) => pickVertical(e.target.value as VerticalSlug)}>
          {(Object.keys(VERTICALS) as VerticalSlug[]).map((v) => (
            <option key={v} value={v}>
              {VERTICALS[v]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Market
        <select value={country} onChange={(e) => setCountry(e.target.value as Country)}>
          {VERTICAL_MARKETS[vertical].map((c) => (
            <option key={c} value={c}>
              {COUNTRIES[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Search title
        <select value={title} onChange={(e) => setTitle(e.target.value)}>
          {SEARCH_TITLES[vertical].map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Posts
        <input type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
      </label>
      <p className="run-cost muted">
        About ${apifyCost(limit).toFixed(4)} of Apify, plus about $0.0005 of AI extraction for each post that passes the gate. Posted in the last 14 days only.
      </p>
      <div className="run-actions">
        <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
          <Play size={14} weight="fill" aria-hidden /> {pending ? "Starting…" : "Run"}
        </button>
      </div>
      <Result r={result} />
    </form>
  );
}

export function RunSource({ source, label }: { source: "sniff" | "search"; label: string }) {
  const [result, setResult] = useState<RunResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="run">
      <button
        type="button"
        className="btn"
        disabled={pending}
        aria-busy={pending}
        aria-label={`Run ${label} now`}
        onClick={() => start(async () => setResult(await runSource(source).catch((err: Error) => ({ ok: false as const, message: err.message }))))}
      >
        <Play size={14} weight="fill" aria-hidden /> {pending ? "Starting…" : "Run now"}
      </button>
      <Result r={result} />
    </div>
  );
}

// Reloads the page data every 10 s while a board run is in progress.
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
