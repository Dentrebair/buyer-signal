"use client";
// Run now controls for the Sources page (§10.3).
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Play } from "@phosphor-icons/react";
import { LI_MAX_COMMENTS, LI_MAX_POSTS, liCostUsd } from "@bs/core/liSearch";
import { SOCIAL_TOPICS } from "@bs/core/social";
import { COUNTRIES, FIXER_TITLES, SEARCH_TITLES, VERTICALS, VERTICAL_MARKETS, type Country, type VerticalSlug } from "@bs/core/verticals";
import { type RunResult, reviveSearch, runJobPosts, runLinkedin, runSource } from "@/app/radar/actions.ts";
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

// "" = fixer hires (§1.1): any vertical, the AI reads it from each post.
type JobScope = VerticalSlug | "";
const titlesFor = (v: JobScope): readonly string[] => (v ? SEARCH_TITLES[v] : FIXER_TITLES);
const marketsFor = (v: JobScope): Country[] => (v ? VERTICAL_MARKETS[v] : (Object.keys(COUNTRIES) as Country[]));

export function RunJobPosts({ next }: { next: { vertical: string | null; country: string; title: string } | null }) {
  const [open, setOpen] = useState(false);
  const [vertical, setVertical] = useState<JobScope>(next ? ((next.vertical ?? "") as JobScope) : "accounting");
  const [country, setCountry] = useState<Country>((next?.country as Country | undefined) ?? marketsFor(vertical)[0]!);
  const [title, setTitle] = useState(next?.title ?? titlesFor(vertical)[0]!);
  const [limit, setLimit] = useState(35);
  const [result, setResult] = useState<RunResult | null>(null);
  const [pending, start] = useTransition();

  const pickVertical = (v: JobScope) => {
    setVertical(v);
    if (!marketsFor(v).includes(country)) setCountry(marketsFor(v)[0]!);
    setTitle(titlesFor(v)[0]!);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await runJobPosts({ vertical: vertical || null, country, title, limit }).catch((err: Error) => ({ ok: false as const, message: err.message }));
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
        <select value={vertical} onChange={(e) => pickVertical(e.target.value as JobScope)}>
          {(Object.keys(VERTICALS) as VerticalSlug[]).map((v) => (
            <option key={v} value={v}>
              {VERTICALS[v]}
            </option>
          ))}
          <option value="">Fixer hires (any vertical)</option>
        </select>
      </label>
      <label className="field">
        Market
        <select value={country} onChange={(e) => setCountry(e.target.value as Country)}>
          {marketsFor(vertical).map((c) => (
            <option key={c} value={c}>
              {COUNTRIES[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Search title
        <select value={title} onChange={(e) => setTitle(e.target.value)}>
          {titlesFor(vertical).map((t) => (
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

// LinkedIn post search (§4.1d): every post and every comment is one $0.002 Apify event.
export function RunLinkedin() {
  const [open, setOpen] = useState(false);
  const [vertical, setVertical] = useState<VerticalSlug>("logistics");
  const [topic, setTopic] = useState("");
  const [posts, setPosts] = useState(10);
  const [comments, setComments] = useState(10);
  const [result, setResult] = useState<RunResult | null>(null);
  const [pending, start] = useTransition();
  const cost = liCostUsd({ posts, comments });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await runLinkedin({ vertical, topics: [topic.trim() || SOCIAL_TOPICS[vertical][0]], posts, comments }).catch((err: Error) => ({
        ok: false as const,
        message: err.message,
      }));
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
    <form className="run-form run-form-social" onSubmit={submit} aria-label="Run LinkedIn post search now">
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
        Topic
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={40}
          placeholder={SOCIAL_TOPICS[vertical][0]}
          aria-describedby="li-topic-help"
        />
        <span id="li-topic-help" className="field-help">
          Searched as a phrase. Leave empty for “{SOCIAL_TOPICS[vertical][0]}”
        </span>
      </label>
      <label className="field">
        Posts
        <select value={posts} onChange={(e) => setPosts(Number(e.target.value))}>
          {[5, 10, 20, 30, LI_MAX_POSTS].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Comments per post
        <select value={comments} onChange={(e) => setComments(Number(e.target.value))}>
          {[0, 5, 10, LI_MAX_COMMENTS].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "None" : n}
            </option>
          ))}
        </select>
      </label>
      <p className="run-cost muted">
        At most ${cost.apify.toFixed(3)} of Apify if every post has {comments} comments, plus about ${cost.ai.toFixed(3)} of AI. Posts from the last 21 days only.
        Keeps each author&apos;s and commenter&apos;s name, headline and profile link for 60 days.
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

export function RunSource({ source, label }: { source: "sniff" | "search" | "drift" | "trends"; label: string }) {
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

// Status cell of a job-post run: the current step, a live timer and the usual time for that step.
export function RunProgress(x: { status: string; startedAt: string; completedAt: string | null }) {
  const [now, setNow] = useState<number | null>(null); // null on the server: no timer in the HTML, so no hydration mismatch
  const done = x.status === "done" || x.status === "failed";
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
        {end ? <span className="meta">Took {clock(end - start)}</span> : null}
      </span>
    );
  }
  const step =
    x.status === "starting"
      ? { n: 1, label: "Starting", usual: "a few seconds" }
      : x.status === "running"
        ? { n: 1, label: "Collecting posts", usual: "1–3 min" }
        : { n: 2, label: "Reading results", usual: "a few seconds" };
  return (
    <span className="run-progress" role="status">
      <span className="run-state run-active">{step.label}</span>
      <Meta
        items={[
          `Step ${step.n} of 2`,
          <span key="t" className="num">
            {now === null ? "…" : clock(now - start)}
          </span>,
          `Usually ${step.usual}`,
        ]}
      />
    </span>
  );
}

// Searches table: bring back a retired search (§4.1c).
export function ReviveSearch({ id, term }: { id: string; term: string }) {
  const [result, setResult] = useState<RunResult | null>(null);
  const [pending, start] = useTransition();
  if (result?.ok) return <span className="run-state run-done">Revived</span>;
  return (
    <span className="revive">
      <button
        type="button"
        className="btn btn-sm"
        disabled={pending}
        aria-busy={pending}
        aria-label={`Revive the search ${term}`}
        onClick={() => start(async () => setResult(await reviveSearch(id).catch((err: Error) => ({ ok: false as const, message: err.message }))))}
      >
        {pending ? "Reviving…" : "Revive"}
      </button>
      {result && !result.ok && <span className="error">{result.message}</span>}
    </span>
  );
}
