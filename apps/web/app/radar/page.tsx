// Sources (PRD §10.3): one row per data source, its latest activity and a Run now control.
// The daily rotation is off for now (worker main.ts), so job posts arrive only from Run now.
import Link from "next/link";
import { ArrowLeft, ArrowSquareOut, Briefcase, Browser, Heartbeat, LinkedinLogo, ListMagnifyingGlass, MagnifyingGlass } from "@phosphor-icons/react/ssr";
import { AutoRefresh, ReviveSearch, RunJobPosts, RunProgress, RunSource } from "@/components/RunNow.tsx";
import { Facts, Meta } from "@/components/Meta.tsx";
import { PostLink } from "@/components/PostLink.tsx";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { ageLabel, countryLabel, verticalLabel } from "@/lib/labels.ts";
import { type Health, healthValue, loadHealth } from "@/lib/health.ts";
import { type BoardRun, type SearchPost, type SearchRow, loadSources } from "@/lib/sources.ts";

export const dynamic = "force-dynamic";

export default async function Radar() {
  const [s, health] = await Promise.all([loadSources(), loadHealth()]);
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
              <Briefcase size={18} aria-hidden /> Job posts
            </h2>
            <Meta
              className="source-meta"
              items={[
                "Indeed",
                j.cycleSpendUsd !== null && j.cycleCapUsd !== null && (
                  <>
                    Apify this cycle <span className="num">${j.cycleSpendUsd.toFixed(2)}</span> of <span className="num">${j.cycleCapUsd.toFixed(2)}</span>
                  </>
                ),
              ]}
            />
          </div>
          <RunJobPosts next={j.next} />
          {j.next && (
            <p className="muted source-note">
              Pre-filled with today&apos;s pick from the search rotation: “{j.next.title}”, {j.next.vertical ? verticalLabel(j.next.vertical) : "any vertical"},{" "}
              {countryLabel(j.next.country)}.
            </p>
          )}
          {j.runs.length > 0 ? <Runs runs={j.runs} /> : <p className="muted">No runs yet.</p>}
        </section>

        <section className="card source" aria-labelledby="src-sniff">
          <div className="source-head">
            <h2 id="src-sniff">
              <Browser size={18} aria-hidden /> Website check
            </h2>
            <Meta className="source-meta" items={["Free", "Runs by itself every 10 minutes"]} />
          </div>
          <Meta
            items={[
              <>
                <span className="num">{s.sniff.pending}</span> waiting
              </>,
              <>
                <span className="num">{s.sniff.done}</span> checked
              </>,
              <>
                <span className="num">{s.sniff.unreachable}</span> unreachable
              </>,
              `Last check ${ageLabel(s.sniff.lastAt)}`,
            ]}
          />
          <RunSource source="sniff" label="website check" />
        </section>

        <section className="card source" aria-labelledby="src-search">
          <div className="source-head">
            <h2 id="src-search">
              <MagnifyingGlass size={18} aria-hidden /> Website search
            </h2>
            <Meta className="source-meta" items={["For cards with no website", "Runs by itself daily at 04:00 UTC"]} />
          </div>
          <Meta
            items={[
              <>
                <span className="num">{s.search.pending}</span> companies waiting
              </>,
              <>
                <span className="num">{s.search.searchedToday}</span> of <span className="num">{s.search.dailyCap}</span> searches used today
              </>,
            ]}
          />
          <RunSource source="search" label="website search" />
        </section>

        <section className="card source" aria-labelledby="src-li">
          <div className="source-head">
            <h2 id="src-li">
              <LinkedinLogo size={18} aria-hidden /> LinkedIn post search
            </h2>
            <Meta className="source-meta" items={["Full posts, comments and contacts", "$0.002 a post or comment"]} />
          </div>
          <p className="muted source-note">
            Searches LinkedIn itself for a topic and reads each post and its comments for pain, with the people behind them. A pain post by the
            business&apos;s own people, with its company named and in one of our markets, becomes an inbox card. The rotation runs it on the
            social topics below.
          </p>
          <div className="run">
            <Link href="/linkedin" className="btn">
              Open LinkedIn post search
            </Link>
          </div>
        </section>
        <HealthSection h={health} />
        <Searches rows={s.searches.rows} untried={s.searches.untried} />
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
                <span className="run-search">{r.query_title ? `“${r.query_title}”` : "No search title"}</span>
                <Facts items={[["vertical", r.vertical ? verticalLabel(r.vertical) : "Fixer hires, any vertical"], ["country", countryLabel(r.country)]]} />
              </td>
              <td>
                <RunProgress status={r.status} startedAt={r.started_at} completedAt={r.completed_at} />
              </td>
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

// Why a post did not become a lead: LinkedIn post search's card gate, or the Google digest's AI.
const AUTHOR: Record<string, string> = {
  founder_owner: "Founder or owner",
  employee: "Employee",
  company_page: "Company page",
  former_employee: "Former employee",
  vendor: "Vendor",
  commentator: "Commentator",
  recruiter: "Recruiter",
};
const STANCE: Record<string, string> = { suffering: "describes a problem", implied: "shows manual work", solved: "how they solved it", selling: "selling", commenting: "commenting" };

function dropReason(d: Pick<SearchPost, "outcome" | "author_relation" | "stance">): string {
  if (d.outcome === "checking") return "Being checked for a card";
  if (d.outcome === "before_cards") return "Read before posts became cards";
  if (d.outcome === "duplicate") return "Already a card from another search";
  if (d.outcome === "no_market") return "Outside our markets";
  if (d.outcome === "no_company") return "No company named";
  if (d.outcome === "no_fit") return "Nothing to automate";
  if (d.outcome === "too_large") return "Company too large";
  if (d.outcome === "ai_error") return "The AI couldn't read it";
  return `${AUTHOR[d.author_relation ?? ""] ?? "Unknown author"}, ${STANCE[d.stance ?? ""] ?? "no manual work"}`;
}

// The posts a search found: what the pain was, the verdict, and the original post.
function SearchPosts({ posts }: { posts: SearchPost[] }) {
  if (!posts.length) return null;
  const leads = posts.filter((p) => p.outcome === "card").length;
  return (
    <details className="search-posts">
      <summary>
        <span className="num">{posts.length}</span> {posts.length === 1 ? "post" : "posts"} found
        {leads > 0 && (
          <>
            , <span className="num">{leads}</span> {leads === 1 ? "lead" : "leads"}
          </>
        )}
      </summary>
      <ul className="social-list">
        {posts.map((p) => {
          const url = p.url && /^https:\/\//i.test(p.url) ? p.url : null;
          const social = p.kind !== "job";
          return (
            <li key={`${p.kind}-${p.id}`} className={`social-item${social && url ? " ev-social" : ""}`}>
              {social && url && <PostLink url={url} sourceType="linkedin_post" id={`sp-${p.id}`} />}
              <div className="lead-head">
                {p.outcome === "card" ? <span className="verdict verdict-green">Lead</span> : <span className="verdict">{dropReason(p)}</span>}
                {p.company_id && (
                  <Link href={`/dashboard?id=${p.company_id}`} className="link lead-name">
                    {p.company_name ?? "Unnamed company"}
                  </Link>
                )}
              </div>
              {p.symptom && (
                <p className="post-pain">
                  <strong>{p.outcome === "card" || p.kind === "li" ? "Pain:" : "Why dropped:"}</strong> {p.symptom}
                </p>
              )}
              {p.title && <p className="social-snippet">{p.title}</p>}
              {p.snippet && <p className="muted social-ai">“{p.snippet}”</p>}
              {!social && url && (
                <a href={url} target="_blank" rel="noopener noreferrer" className="link post-open">
                  Open the job ad <ArrowSquareOut size={13} aria-hidden />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// Health (agreed 2026-11-08): has the AI or a search drifted? The drift check compares the last
// 7 days with the 14 before; the AI test set scores the AI against the operator's labels.
const VERDICT: Record<string, string> = { ok: "Steady", too_few: "Too few to judge" };
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

function HealthSection({ h }: { h: Health }) {
  const labelled = h.labelled.lead + h.labelled.pain + h.labelled.none;
  const last = h.evals[0];
  return (
    <section className="card source" aria-labelledby="src-health" id="src-health">
      <div className="source-head">
        <h2 id="src-health">
          <Heartbeat size={18} aria-hidden /> Health
        </h2>
        <Meta className="source-meta" items={["Free", "Runs by itself daily at 05:30 UTC", h.day && `Last check ${ageLabel(h.day)}`]} />
      </div>
      <p className="muted source-note">
        The last 7 days against the 14 before. A number is marked when it moved more than chance explains: a fall in leads, or a jump the AI
        may have caused by turning lenient.
      </p>
      {h.drift.length === 0 ? (
        <p className="muted">Not checked yet.</p>
      ) : (
        <div className="runs-wrap">
          <table className="runs health">
            <caption className="sr-only">Health numbers, the 14 days before against the last 7 days</caption>
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col" className="r">
                  14 days before
                </th>
                <th scope="col" className="r">
                  Last 7 days
                </th>
                <th scope="col">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {h.drift.map((r) => (
                <tr key={r.metric}>
                  <td>{r.label}</td>
                  <td className="r">
                    <span className="num">{healthValue(r, r.base)}</span> <span className="muted">of {r.baseN}</span>
                  </td>
                  <td className="r">
                    <span className="num">{healthValue(r, r.window)}</span> <span className="muted">of {r.windowN}</span>
                  </td>
                  <td className={r.worse ? "is-error" : undefined}>
                    {r.verdict === "moved" ? `Moved ${r.direction}${r.worse ? ", worse" : ""}` : VERDICT[r.verdict]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RunSource source="drift" label="health check" />

      <h3 className="health-sub">AI test set</h3>
      <p className="muted source-note">
        {labelled === 0
          ? "No posts labelled yet. On LinkedIn search, Posts tab, give each post your verdict: a lead, pain but not a lead, or no pain. Aim for 50, at least 10 of them leads."
          : `${labelled} posts labelled: ${h.labelled.lead} leads, ${h.labelled.pain} pain but not a lead, ${h.labelled.none} no pain.`}{" "}
        Run <code>npm run eval</code> after any prompt or model change, and weekly: about $0.0004 a post.
      </p>
      {last && (
        <div className="runs-wrap">
          <table className="runs health">
            <caption className="sr-only">Latest AI test set scores</caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Model, prompt</th>
                <th scope="col" className="r">
                  Posts
                </th>
                <th scope="col" className="r">
                  Pain found
                </th>
                <th scope="col" className="r">
                  Leads found
                </th>
                <th scope="col" className="r">
                  Wrong leads
                </th>
                <th scope="col" className="r">
                  Agreement
                </th>
              </tr>
            </thead>
            <tbody>
              {h.evals.map((e) => (
                <tr key={e.created_at}>
                  <td>{ageLabel(e.created_at)}</td>
                  <td>
                    {e.model} <span className="muted num">{e.prompt_hash}</span>
                  </td>
                  <td className="r num">{e.cases}</td>
                  <td className="r num">{pct(e.pain_recall)}</td>
                  <td className="r num">{pct(e.lead_recall)}</td>
                  <td className="r num">{e.lead_precision === null ? "—" : pct(1 - e.lead_precision)}</td>
                  <td className="r num">{pct(e.agreement)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// What the search rotation has learned (§4.1c): every search that has run, best first.
const STATUS_LABEL: Record<SearchRow["status"], string> = { trying: "Trying", strong: "Strong", weak: "Weak", retired: "Retired" };
const GROUP_LABEL: Record<SearchRow["group"], string> = { high: "High urgency", medium: "Medium urgency", low: "Low urgency" };

function Searches({ rows, untried }: { rows: SearchRow[]; untried: { job: number; social: number } }) {
  return (
    <section className="card source" aria-labelledby="src-searches">
      <div className="source-head">
        <h2 id="src-searches">
          <ListMagnifyingGlass size={18} aria-hidden /> Searches
        </h2>
        <Meta className="source-meta" items={[`${untried.job} job searches not tried yet`, `${untried.social} social topics not tried yet`]} />
      </div>
      <p className="muted source-note">
        Each search is scored on cards per dollar, minus cards you reject as not real pain or the wrong company; a Low urgency card counts a quarter
        and older runs count less. A search with 5 runs and no card retires itself. Open a search&apos;s posts to see each pain and the original post.
      </p>
      {rows.length === 0 ? (
        <p className="muted">No search has run yet.</p>
      ) : (
        <div className="runs-wrap">
          <table className="runs searches">
            <caption className="sr-only">Searches the rotation has tried</caption>
            <thead>
              <tr>
                <th scope="col">Search</th>
                <th scope="col">Status</th>
                <th scope="col" className="r">
                  Runs
                </th>
                <th scope="col" className="r">
                  Cards
                </th>
                <th scope="col" className="r">
                  Cost
                </th>
                <th scope="col" className="r">
                  Cards per $
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="run-search">
                      {r.kind === "job" ? "Job ads for" : "Posts about"} “{r.term}”
                    </span>
                    <span className="facts">
                      <span className={`urgency-tag urgency-${r.group}`}>{GROUP_LABEL[r.group]}</span>
                      <span className="fact fact-vertical">{r.vertical ? verticalLabel(r.vertical) : "Any vertical"}</span>
                      <span className="fact fact-country">{countryLabel(r.country)}</span>
                    </span>
                    <SearchPosts posts={r.posts} />
                  </td>
                  <td>
                    <span className={`run-state search-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                    {r.status === "retired" && <ReviveSearch id={r.id} term={r.term} />}
                  </td>
                  <td className="r num">{r.runs}</td>
                  <td className="r num">
                    {r.cards}
                    {r.junk > 0 && <span className="muted"> ({r.junk} rejected)</span>}
                  </td>
                  <td className="r num">${r.cost.toFixed(4)}</td>
                  <td className="r num">{Math.round(r.perDollar)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
