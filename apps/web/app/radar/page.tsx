// Sources (PRD §10.3): one row per data source, its latest activity and a Run now control.
// The daily rotation is off for now (worker main.ts), so job posts arrive only from Run now.
import Link from "next/link";
import { ArrowLeft, Briefcase, Browser, ChatsCircle, MagnifyingGlass } from "@phosphor-icons/react/ssr";
import { AutoRefresh, RunJobPosts, RunProgress, RunSocial, RunSource } from "@/components/RunNow.tsx";
import { PostLink } from "@/components/PostLink.tsx";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { SCOPE_LABEL, ageLabel, countryLabel, scopeOf, verticalLabel } from "@/lib/labels.ts";
import { type BoardRun, type SocialDrop, type SocialLead, loadSources } from "@/lib/sources.ts";

export const dynamic = "force-dynamic";

export default async function Radar({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const run = (await searchParams).run;
  const s = await loadSources(typeof run === "string" ? run : null);
  const j = s.jobs;
  return (
    <div className="radar">
      <AutoRefresh active={j.running + s.social.running > 0} />
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
          {j.runs.length > 0 ? <Runs runs={j.runs} kind="jobs" /> : <p className="muted">No runs yet.</p>}
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

        <section className="card source" aria-labelledby="src-social">
          <div className="source-head">
            <h2 id="src-social">
              <ChatsCircle size={18} aria-hidden /> Social digest
            </h2>
            <span className="source-meta">Posts by founders, staff and company pages · last 21 days</span>
          </div>
          <RunSocial />
          <p className="muted source-note">
            Searches by topic, not by phrasing: each run takes the next few topics for the vertical, or the keyword you type. The AI keeps complaints
            and upbeat posts that show manual work (marked Implied).
          </p>
          {s.social.runs.length > 0 ? <Runs runs={s.social.runs} kind="social" shownId={s.social.shown?.id ?? null} /> : <p className="muted">No runs yet.</p>}
          {s.social.shown && <SocialLeads run={s.social.shown} leads={s.social.leads} />}
          {s.social.drops.length > 0 && <AiDrops drops={s.social.drops} />}
        </section>
      </main>
    </div>
  );
}

function Runs({ runs, kind, shownId = null }: { runs: BoardRun[]; kind: "jobs" | "social"; shownId?: string | null }) {
  return (
    <div className="runs-wrap">
      <table className="runs">
        <caption className="sr-only">{kind === "jobs" ? "Latest job-post runs" : "Latest social digest runs"}</caption>
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
            <tr key={r.id} className={r.id === shownId ? "is-shown" : undefined}>
              <td>{ageLabel(r.started_at)}</td>
              <td>
                {r.query_title ? `"${r.query_title}"` : "—"}
                <span className="muted">
                  {" "}
                  · {r.vertical ? `${verticalLabel(r.vertical)} · ` : ""}{countryLabel(r.country)}
                </span>
              </td>
              <td>
                <RunProgress status={r.status} startedAt={r.started_at} completedAt={r.completed_at} checking={r.checking} kind={kind} />
              </td>
              <td className="r num">
                {kind === "social" && r.raw > 0 ? (
                  <Link
                    href={`/radar?run=${r.id}#social-posts`}
                    className="link"
                    aria-current={r.id === shownId ? "true" : undefined}
                    aria-label={`Show the leads from this run (${r.raw} posts searched)`}
                  >
                    {r.raw}
                  </Link>
                ) : (
                  r.raw
                )}
              </td>
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

// "Full automation · 75%" / "Partial automation · 40%", as on the inbox cards.
function ScopeTag({ pct }: { pct: number | null }) {
  const scope = scopeOf(pct);
  if (!scope) return null;
  return (
    <span className={`scope-tag scope-${scope}`}>
      {SCOPE_LABEL[scope]} · <span className="num">{pct}%</span>
    </span>
  );
}

// Only the posts that became cards; the run's counts above say how many were dropped.
function SocialLeads({ run, leads }: { run: BoardRun; leads: SocialLead[] }) {
  return (
    <section className="social-posts" id="social-posts" aria-labelledby="social-posts-h">
      <h3 id="social-posts-h">
        New leads from the {ageLabel(run.started_at)} run <span className="muted num">· {leads.length}</span>
      </h3>
      <p className="muted social-ai">{run.query_title ?? "search"}</p>
      {leads.length === 0 ? (
        <p className="muted social-empty">
          {run.checking > 0 ? `The AI is still reading ${run.checking} post${run.checking > 1 ? "s" : ""}.` : `None: no post out of ${run.raw} showed a named business's own manual work.`}
        </p>
      ) : (
        <ul className="social-list">
          {leads.map((l) => {
            const url = /^https:\/\//i.test(l.url) ? l.url : null;
            return (
              <li key={l.id} className={`social-item${url ? " ev-social" : ""}`}>
                {url && <PostLink url={url} sourceType="linkedin_post" id={`sr-${l.id}`} />}
                <div className="lead-head">
                  {l.company_id ? (
                    <Link href={`/dashboard?id=${l.company_id}`} className="link lead-name">
                      {l.company_name ?? "Unnamed company"}
                    </Link>
                  ) : (
                    <span className="lead-name">{l.company_name ?? "Unnamed company"}</span>
                  )}
                  <ScopeTag pct={l.automatable_pct} />
                  {l.stance === "implied" && (
                    <span className="verdict" title="An upbeat or neutral post that shows manual work; the pain is inferred, so it scores lower">
                      Implied
                    </span>
                  )}
                </div>
                {l.symptom && <p className="social-snippet">{l.symptom}</p>}
                <p className="muted social-ai">
                  “{l.snippet}”{l.posted_at && <> · posted {ageLabel(l.posted_at)}</>}
                  {l.signal_score !== null && (
                    <>
                      {" "}
                      · signal <span className="num">{l.signal_score}</span>
                    </>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// The AI's drops, so a real post dropped by mistake can be caught. Free drops are not kept.
const AUTHOR: Record<string, string> = {
  founder_owner: "Founder or owner",
  employee: "Employee",
  company_page: "Company page",
  former_employee: "Former employee",
  vendor: "Vendor",
  commentator: "Commentator",
  recruiter: "Recruiter",
};
const STANCE: Record<string, string> = { suffering: "describes a problem", implied: "shows manual work", selling: "selling", commenting: "commenting" };

function dropReason(d: SocialDrop): string {
  if (d.outcome === "no_company") return "No company named";
  if (d.outcome === "no_fit") return "Nothing to automate";
  if (d.outcome === "too_large") return "Company too large";
  return `${AUTHOR[d.author_relation ?? ""] ?? "Unknown author"}, ${STANCE[d.stance ?? ""] ?? "no manual work"}`;
}

function AiDrops({ drops }: { drops: SocialDrop[] }) {
  return (
    <details className="ai-drops">
      <summary>
        Check the AI&apos;s drops <span className="muted num">· {drops.length}</span> <span className="muted">· kept 7 days</span>
      </summary>
      <ul className="social-list">
        {drops.map((d) => {
          const url = /^https:\/\//i.test(d.url) ? d.url : null;
          return (
            <li key={d.id} className={`social-item${url ? " ev-social" : ""}`}>
              {url && <PostLink url={url} sourceType="linkedin_post" id={`dr-${d.id}`} />}
              <span className="verdict">{dropReason(d)}</span>
              {d.symptom && <p className="muted social-ai">AI: {d.symptom}</p>}
              {d.snippet && <p className="social-snippet">“{d.snippet}”</p>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
