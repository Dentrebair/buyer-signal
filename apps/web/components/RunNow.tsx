"use client";
// Run now controls for the Sources page (§10.3).
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Play } from "@phosphor-icons/react";
import { SOCIAL_TOPICS } from "@bs/core/social";
import { COUNTRIES, SEARCH_TITLES, VERTICALS, VERTICAL_MARKETS, type Country, type VerticalSlug } from "@bs/core/verticals";
import { type RunResult, runJobPosts, runSocial, runSource } from "@/app/radar/actions.ts";
import { Meta } from "./Meta.tsx";

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
      if (r.ok) (setOpen(false), announceRun());
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

// Search pages cost $0.0045 each (~10 results); extraction runs only on posts that pass the gate.
export function RunSocial() {
  const [open, setOpen] = useState(false);
  const [vertical, setVertical] = useState<VerticalSlug>("logistics");
  const [keyword, setKeyword] = useState("");
  const [country, setCountry] = useState<Country>("us");
  const [pages, setPages] = useState(1);
  const [result, setResult] = useState<RunResult | null>(null);
  const [pending, start] = useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await runSocial({ vertical, keyword: keyword.trim() || null, country, pages }).catch((err: Error) => ({ ok: false as const, message: err.message }));
      setResult(r);
      if (r.ok) (setOpen(false), announceRun());
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
    <form className="run-form" onSubmit={submit} aria-label="Run social digest now">
      <label className="field">
        Vertical
        <select value={vertical} onChange={(e) => setVertical(e.target.value as VerticalSlug)}>
          {(Object.keys(VERTICALS) as VerticalSlug[]).map((v) => (
            <option key={v} value={v}>
              {VERTICALS[v]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Keyword <span className="muted">(optional)</span>
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          maxLength={40}
          placeholder={`e.g. ${SOCIAL_TOPICS[vertical][0]}`}
          aria-describedby="social-kw-help"
        />
        <span id="social-kw-help" className="muted">
          Empty: the next topics for this vertical
        </span>
      </label>
      <label className="field">
        Market
        <select value={country} onChange={(e) => setCountry(e.target.value as Country)}>
          {(Object.keys(COUNTRIES) as Country[]).map((c) => (
            <option key={c} value={c}>
              {COUNTRIES[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Result pages
        <select value={pages} onChange={(e) => setPages(Number(e.target.value))}>
          {[1, 2, 3].map((n) => (
            <option key={n} value={n}>
              {n} (~{n * 10} posts)
            </option>
          ))}
        </select>
      </label>
      <p className="run-cost muted">
        About ${(pages * 0.0045 + 0.00005).toFixed(4)} of Apify, plus about $0.0005 of AI per post that passes the gate. Posts from the last 21 days only.
        Expect few leads: most posts are vendors or commentators, and those are dropped.
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

// A Run click queues the job; the worker creates the run row a few seconds later, so the page
// cannot see it yet. The click announces itself and AutoRefresh watches for the next 2 minutes.
const RUN_STARTED = "bs:run-started";
const announceRun = () => window.dispatchEvent(new Event(RUN_STARTED));

// Reloads the page data every 5 s while a run is in progress or was just started.
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  const [watchUntil, setWatchUntil] = useState(0);
  useEffect(() => {
    const on = () => setWatchUntil(Date.now() + 120_000);
    window.addEventListener(RUN_STARTED, on);
    return () => window.removeEventListener(RUN_STARTED, on);
  }, []);
  const watching = active || watchUntil > 0;
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => {
      router.refresh();
      if (watchUntil && Date.now() > watchUntil) setWatchUntil(0);
    }, 5_000);
    return () => clearInterval(t);
  }, [watching, watchUntil, router]);
  return null;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

// Status cell: the current step, a live timer and the usual time for that step.
export function RunProgress(x: { status: string; startedAt: string; completedAt: string | null; checking: number; kind: "jobs" | "social" }) {
  const [now, setNow] = useState<number | null>(null); // null on the server: no timer in the HTML, so no hydration mismatch
  const done = (x.status === "done" && x.checking === 0) || x.status === "failed";
  useEffect(() => {
    setNow(Date.now());
    if (done) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [done]);
  const start = Date.parse(x.startedAt);
  if (x.status === "failed") return <span className="run-state run-failed">Failed</span>;
  if (done) {
    const end = x.completedAt ? Date.parse(x.completedAt) : null;
    return (
      <span className="run-progress">
        <span className="run-state run-done">Done</span>
        {end && x.kind === "jobs" ? <span className="meta">Took {clock(end - start)}</span> : null}
      </span>
    );
  }
  const step =
    x.status === "starting"
      ? { n: 1, label: "Starting", usual: "a few seconds" }
      : x.status === "running"
        ? { n: 1, label: x.kind === "social" ? "Searching Google" : "Collecting posts", usual: x.kind === "social" ? "under 1 min" : "1–3 min" }
        : x.status === "fetching"
          ? { n: 2, label: "Reading results", usual: "a few seconds" }
          : { n: 3, label: `AI reading posts, ${x.checking} left`, usual: `about ${Math.max(1, Math.round((x.checking * 6) / 2))}s` };
  return (
    <span className="run-progress" role="status">
      <span className="run-state run-active">{step.label}</span>
      <Meta
        items={[
          `Step ${step.n} of 3`,
          <span key="t" className="num">
            {now === null ? "…" : clock(now - start)}
          </span>,
          `Usually ${step.usual}`,
        ]}
      />
    </span>
  );
}
