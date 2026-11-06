// Sources (PRD §10.3): one row per data source, its latest activity and a Run now control.
// The daily rotation is off for now (worker main.ts), so job posts arrive only from Run now.
import Link from "next/link";
import { ArrowLeft, Briefcase, Browser, ChatsCircle, MagnifyingGlass } from "@phosphor-icons/react/ssr";
import { AutoRefresh, RunJobPosts, RunSource } from "@/components/RunNow.tsx";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { ageLabel, countryLabel, verticalLabel } from "@/lib/labels.ts";
import { type BoardRun, loadSources } from "@/lib/sources.ts";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  starting: "Starting",
  running: "Running on Apify",
  fetching: "Reading posts",
  done: "Done",
  failed: "Failed",
};

export default async function Radar() {
  const s = await loadSources();
  const j = s.jobs;
  return (
    <div className="radar">
      <AutoRefresh active={j.running > 0} />
      <header className="radar-head">
        <Link href="/dashboard" className="radar-back">
          <ArrowLeft size={16} aria-hidden /> Inbox
        </Link>
        <h1>Sources</h1>
        <ThemeToggle />
      </header>

      <main className="radar-main">
        <p className="muted radar-intro">
          The daily rotation is switched off, so new job posts come only from Run now. Spend caps still apply: a run past the Apify cycle cap or
          the daily search quota waits instead of running.
        </p>

        <section className="card source" aria-labelledby="src-jobs">
          <div className="source-head">
            <h2 id="src-jobs">
              <Briefcase size={18} aria-hidden /> Job posts <span className="muted">· Indeed</span>
            </h2>
            {j.cycleSpendUsd !== null && j.cycleCapUsd !== null && (
              <span className="source-meta num">
                Apify this cycle ${j.cycleSpendUsd.toFixed(2)} of ${j.cycleCapUsd.toFixed(2)}
              </span>
            )}
          </div>
          <RunJobPosts next={j.next} />
          {j.next && (
            <p className="muted source-note">
              Pre-filled with the next slot in rotation order: {verticalLabel(j.next.vertical)}, {countryLabel(j.next.country)}.
            </p>
          )}
          {j.runs.length > 0 ? <Runs runs={j.runs} /> : <p className="muted">No runs yet.</p>}
        </section>

        <section className="card source" aria-labelledby="src-sniff">
          <div className="source-head">
            <h2 id="src-sniff">
              <Browser size={18} aria-hidden /> Website check <span className="muted">· free</span>
            </h2>
            <span className="source-meta">Runs by itself every 10 minutes</span>
          </div>
          <p>
            <span className="num">{s.sniff.pending}</span> waiting · <span className="num">{s.sniff.done}</span> checked ·{" "}
            <span className="num">{s.sniff.unreachable}</span> unreachable · last check {ageLabel(s.sniff.lastAt)}
          </p>
          <RunSource source="sniff" label="website check" />
        </section>

        <section className="card source" aria-labelledby="src-search">
          <div className="source-head">
            <h2 id="src-search">
              <MagnifyingGlass size={18} aria-hidden /> Website search <span className="muted">· for cards with no website</span>
            </h2>
            <span className="source-meta">Runs by itself daily at 04:00 UTC</span>
          </div>
          <p>
            <span className="num">{s.search.pending}</span> companies waiting · <span className="num">{s.search.searchedToday}</span> of{" "}
            <span className="num">{s.search.dailyCap}</span> searches used today
          </p>
          <RunSource source="search" label="website search" />
        </section>

        <section className="card source is-off" aria-labelledby="src-social">
          <div className="source-head">
            <h2 id="src-social">
              <ChatsCircle size={18} aria-hidden /> Social digest
            </h2>
            <span className="badge-off">Not built yet</span>
          </div>
          <p className="muted">Posts by founders, staff and company pages that describe manual work at their company (§4.1a).</p>
        </section>
      </main>
    </div>
  );
}

function Runs({ runs }: { runs: BoardRun[] }) {
  return (
    <div className="runs-wrap">
      <table className="runs">
        <caption className="sr-only">Latest job-post runs</caption>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Search</th>
            <th scope="col">Status</th>
            <th scope="col" className="r">
              Posts
            </th>
            <th scope="col" className="r">
              Passed gate
            </th>
            <th scope="col" className="r">
              Cards
            </th>
            <th scope="col" className="r">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{ageLabel(r.started_at)}</td>
              <td>
                {r.query_title ? `"${r.query_title}"` : "—"}
                <span className="muted">
                  {" "}
                  · {r.vertical ? verticalLabel(r.vertical) : "no vertical"} · {countryLabel(r.country)}
                </span>
              </td>
              <td className={r.status === "failed" ? "is-error" : undefined}>{STATUS[r.status] ?? r.status}</td>
              <td className="r num">{r.raw}</td>
              <td className="r num">{r.passed}</td>
              <td className="r num">{r.cards}</td>
              <td className="r num">${r.cost_usd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
