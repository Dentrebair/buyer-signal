// Health dashboard (agreed 2026-11-08): is the pipeline working, what does it cost, and has the AI
// or the company-check agent drifted? One range picker scopes every figure below it.
import Link from "next/link";
import { ArrowLeft, Heartbeat } from "@phosphor-icons/react/ssr";
import { ColumnChart, LineChart } from "@/components/Charts.tsx";
import { RankedBars, StatTile } from "@/components/Figures.tsx";
import { Meta } from "@/components/Meta.tsx";
import { RunSource } from "@/components/RunNow.tsx";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { type Health, healthValue, loadHealth } from "@/lib/health.ts";
import { ageLabel, verticalLabel } from "@/lib/labels.ts";
import { type Budget, type Leak, RANGES, ROTATION_DAY_USD, loadObserve, parseRange } from "@/lib/observe.ts";
import { ProposalActions } from "@/components/ProposalActions.tsx";

export const dynamic = "force-dynamic";

const usd = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(v === 0 ? 2 : 4)}`);
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
// Relative change; null when the period before had nothing to compare with.
const change = (now: number | null, before: number | null) => (now === null || before === null || before === 0 ? null : (now - before) / before);

const NOT_A_CARD: Record<string, string> = {
  not_own: "Not the business's own pain",
  no_company: "No company named",
  no_market: "Outside our markets",
  duplicate: "Already a card",
  no_fit: "Nothing to automate",
  too_large: "Company too large",
  ai_error: "AI couldn't fill the card",
};
const STOPPED: Record<string, string> = { finish: "Finished with an answer", steps: "Ran out of steps (6)", cost: "Hit the $0.05 cost cap" };
const SOURCE: Record<string, string> = { indeed: "Job posts (Indeed)", li_posts: "LinkedIn post search", linkedin: "Google digest (retired)" };

export default async function HealthPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const range = parseRange((await searchParams).days);
  const [o, h] = await Promise.all([loadObserve(range), loadHealth()]);
  const { now, before } = o;
  const period = `the ${range} days before`;
  const cmp = (now: number | null, before: number | null, shown: string, upIsGood: boolean | null) => ({ period, before: shown, change: change(now, before), upIsGood });
  const costPerCard = ratio(now.ai_usd, now.cards);
  const costBefore = ratio(before.ai_usd, before.cards);
  const pain = ratio(now.li_pain, now.li_read);
  const painBefore = ratio(before.li_pain, before.li_read);
  const errors = ratio(now.li_errors, now.li_read + now.li_errors);
  const errorsBefore = ratio(before.li_errors, before.li_read + before.li_errors);
  const days = o.days.map((d) => d.day);
  return (
    <div className="radar">
      <header className="radar-head">
        <Link href="/dashboard" className="radar-back">
          <ArrowLeft size={16} aria-hidden /> Inbox
        </Link>
        <h1>Health</h1>
        <ThemeToggle />
      </header>

      <main className="radar-main health-main">
        <nav className="health-range" aria-label="Date range">
          <span className="li-cell-sub">Showing the last</span>
          <span className="segmented">
            {RANGES.map((r) => (
              <Link key={r} href={`/health?days=${r}`} aria-current={r === range ? "true" : undefined}>
                {r} days
              </Link>
            ))}
          </span>
          <span className="li-cell-sub">against the {range} days before</span>
        </nav>

        <section className="card source" aria-labelledby="h-alerts" id="alerts">
          <div className="source-head">
            <h2 id="h-alerts">Alerts</h2>
            <Meta className="source-meta" items={["Checked daily at 06:00 UTC", "Emailed when RESEND_API_KEY and ALERT_EMAIL_TO are set"]} />
          </div>
          {h.alerts.length === 0 ? (
            <p className="muted">Nothing in the last 3 days: budgets under 80 %, no failed runs or jobs, and cards on the days searches ran.</p>
          ) : (
            <ul className="social-list">
              {h.alerts.map((a) => (
                <li key={`${a.day}-${a.kind}`} className="social-item">
                  <span className="li-cell-sub">
                    {new Date(`${a.day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}, {a.emailed ? "emailed" : "not emailed"}
                  </span>
                  <p className="post-pain">{a.message}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card source" aria-labelledby="h-budget">
          <h2 id="h-budget">Budget</h2>
          <div className="kpis">
            {o.budgets.map((b) => (
              <BudgetTile key={b.label} b={b} />
            ))}
          </div>
        </section>

        <section className="kpis" aria-label="Headline numbers">
          <StatTile label="New cards" value={now.cards.toLocaleString("en-US")} compare={cmp(now.cards, before.cards, String(before.cards), true)} spark={o.days.map((d) => d.cards)} />
          <StatTile label="AI spend" value={usd(now.ai_usd)} compare={cmp(now.ai_usd, before.ai_usd, usd(before.ai_usd), null)} spark={o.days.map((d) => d.ai_usd)} />
          <StatTile label="Apify spend" value={usd(now.apify_usd)} compare={cmp(now.apify_usd, before.apify_usd, usd(before.apify_usd), null)} spark={o.days.map((d) => d.apify_usd)} />
          <StatTile label="AI cost per card" value={costPerCard === null ? "—" : usd(costPerCard)} compare={cmp(costPerCard, costBefore, costBefore === null ? "no cards" : usd(costBefore), false)} />
          <StatTile label="LinkedIn posts with pain" value={pct(pain)} compare={cmp(pain, painBefore, pct(painBefore), true)} spark={o.days.map((d) => d.li_pain)} note={`${now.li_pain} of ${now.li_read} posts read`} />
          <StatTile label="AI couldn't read" value={pct(errors)} compare={cmp(errors, errorsBefore, pct(errorsBefore), false)} note={`${now.li_errors} posts; ${now.failed_runs} of ${now.runs} runs failed`} />
        </section>

        <section className="card source" aria-labelledby="h-spend">
          <h2 id="h-spend">Spend and cards</h2>
          <div className="viz-grid-2">
            <ColumnChart
              title="Spend per day"
              days={days}
              f="usd"
              series={[
                { key: "ai", label: "AI (OpenRouter)", values: o.days.map((d) => d.ai_usd), slot: 1 },
                { key: "apify", label: "Apify", values: o.days.map((d) => d.apify_usd), slot: 2 },
              ]}
            />
            <ColumnChart title="New cards per day" days={days} f="int" series={[{ key: "cards", label: "cards", values: o.days.map((d) => d.cards), slot: 1 }]} />
          </div>
          <div className="runs-wrap">
            <table className="runs">
              <caption className="sr-only">Runs by source in this range</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col" className="r">Runs</th>
                  <th scope="col" className="r">Cost</th>
                  <th scope="col" className="r">Cards</th>
                  <th scope="col" className="r">Cost per card</th>
                </tr>
              </thead>
              <tbody>
                {o.sources.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No runs in this range.
                    </td>
                  </tr>
                )}
                {o.sources.map((s) => (
                  <tr key={s.source}>
                    <td>{SOURCE[s.source] ?? s.source}</td>
                    <td className="r num">{s.runs}</td>
                    <td className="r num">{usd(s.usd)}</td>
                    <td className="r num">{s.cards}</td>
                    <td className="r num">{s.cards > 0 ? usd(s.usd / s.cards) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card source" aria-labelledby="h-li">
          <h2 id="h-li">LinkedIn post search</h2>
          <div className="viz-grid-2">
            <RankedBars
              title="From post to card"
              total={o.funnel.read}
              empty="No LinkedIn posts read in this range."
              rows={[
                { label: "Posts read", n: o.funnel.read },
                { label: "Showed pain", n: o.funnel.pain },
                { label: "Passed the card gate", n: o.funnel.kept },
                { label: "Became cards", n: o.funnel.cards },
              ]}
            />
            <RankedBars
              title="Why pain posts did not become cards"
              empty="None yet: every pain post became a card, or none were checked."
              rows={o.notCards.map((r) => ({ label: NOT_A_CARD[r.outcome] ?? r.outcome, n: r.n }))}
            />
          </div>
        </section>

        <section className="card source" aria-labelledby="h-check">
          <h2 id="h-check">Company-check agent</h2>
          <div className="viz-grid-2">
            <div className="kpis kpis-inline">
              <StatTile label="Companies checked" value={o.checks.n.toLocaleString("en-US")} />
              <StatTile label="Found a website" value={pct(ratio(o.checks.found, o.checks.n))} note={`${o.checks.found} of ${o.checks.n}`} />
              <StatTile label="Steps per check" value={o.checks.avg_steps === null ? "—" : o.checks.avg_steps.toFixed(1)} note="At most 6" />
              <StatTile label="Cost per check" value={o.checks.avg_usd === null ? "—" : usd(o.checks.avg_usd)} note="Capped at $0.05" />
            </div>
            <RankedBars title="How checks ended" empty="No company checks in this range: they run in the daily website search." rows={o.checks.stopped.map((r) => ({ label: STOPPED[r.by] ?? r.by, n: r.n }))} />
          </div>
        </section>

        <LeakSection l={o.leak} />
        <Drift h={h} />
        <Evals h={h} />
      </main>
    </div>
  );
}

// Spend against the cap the gates enforce, with a meter, and where the period will end up.
function BudgetTile({ b }: { b: Budget }) {
  const share = b.cap > 0 ? Math.min(b.spent / b.cap, 1) : 0;
  const over = (v: number) => (v > b.cap ? " (over the cap: later runs wait for the next period)" : "");
  const ends = new Date(`${b.ends}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <div className="kpi">
      <span className="kpi-label">{b.label}</span>
      <span className="kpi-value">
        {usd(b.spent)} <span className="kpi-of">of {usd(b.cap)}</span>
      </span>
      <span className={`meter${share >= 0.8 ? " meter-high" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={b.cap} aria-valuenow={b.spent} aria-label={`${b.label}: ${usd(b.spent)} of ${usd(b.cap)}`}>
        <span className="meter-fill" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="kpi-note">
        Resets {ends}, in {b.daysLeft} days. At the last 7 days&apos; rate ({usd(b.perDay)} a day): {usd(b.projected)}
        {over(b.projected)}.
      </span>
      {b.withRotation !== null && (
        <span className="kpi-note">
          With the daily rotation on (about {usd(ROTATION_DAY_USD)} a day): {usd(b.withRotation)}
          {over(b.withRotation)}.
        </span>
      )}
    </div>
  );
}

const CATEGORY: Record<string, string> = {
  AUTOMATABLE_TASK: "A task software could do",
  MANUAL_ROLE: "A title for manual work",
  INTEGRATION_DEBT: "Copying between systems",
  DOCUMENT_FRICTION: "Paper and documents",
  INFORMATION_SILO: "Knowledge scattered or undocumented",
};

// Leak check (§6.3 step 6): did the free keyword filter drop real leads? Phrases from those
// posts wait here for the operator's verdict.
function LeakSection({ l }: { l: Leak }) {
  return (
    <section className="card source" aria-labelledby="h-leak">
      <div className="source-head">
        <h2 id="h-leak">Leak check</h2>
        <Meta className="source-meta" items={["2 % of the job posts the keyword filter drops", "Read daily at 05:00 UTC, ≈ $0.01 a day"]} />
      </div>
      <div className="kpis kpis-inline">
        <StatTile label="Dropped posts sampled" value={l.sampled.toLocaleString("en-US")} note={`${l.pending} waiting to be read`} />
        <StatTile label="Were real leads" value={pct(ratio(l.leads, l.checked))} note={`${l.leads} of ${l.checked} read`} />
      </div>
      <h3 className="health-sub">
        Phrases to review <span className="num muted">{l.proposals.length}</span>
      </h3>
      <p className="muted source-note">
        Each phrase comes word for word from a dropped post the AI judged a real lead. Approve it and the keyword filter keeps posts that use it
        (for that vertical). A rejected phrase comes back only if its evidence doubles. {l.approved} approved and {l.rejected} rejected so far.
      </p>
      {l.proposals.length === 0 ? (
        <p className="muted">Nothing to review.</p>
      ) : (
        <ul className="social-list">
          {l.proposals.map((p) => (
            <li key={p.id} className="social-item proposal">
              <div className="lead-head">
                <span className="lead-name">“{p.phrase}”</span>
                <span className="verdict">{CATEGORY[p.category] ?? p.category}</span>
                <span className="verdict">{p.vertical ? verticalLabel(p.vertical) : "Any vertical"}</span>
                {p.back && <span className="verdict">Back: its evidence doubled</span>}
              </div>
              <span className="li-cell-sub">
                In <span className="num">{p.evidence}</span> dropped {p.evidence === 1 ? "post" : "posts"} that were leads
              </span>
              {p.example && <p className="muted social-ai">“{p.example.length >= 220 ? `${p.example}…` : p.example}”</p>}
              <ProposalActions id={p.id} phrase={p.phrase} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const VERDICT: Record<string, string> = { ok: "Steady", too_few: "Too few to judge" };

function Drift({ h }: { h: Health }) {
  return (
    <section className="card source" aria-labelledby="h-drift" id="drift">
      <div className="source-head">
        <h2 id="h-drift">
          <Heartbeat size={18} aria-hidden /> Drift check
        </h2>
        <Meta className="source-meta" items={["Free", "Runs by itself daily at 05:30 UTC", h.day && `Last check ${ageLabel(h.day)}`]} />
      </div>
      <p className="muted source-note">
        Always the last 7 days against the 14 before, whatever the range above. A number is marked when it moved more than chance explains: a
        fall in leads, or a jump the AI may have caused by turning lenient.
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
                <th scope="col" className="r">14 days before</th>
                <th scope="col" className="r">Last 7 days</th>
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
                  <td className={r.worse ? "is-error" : undefined}>{r.verdict === "moved" ? `Moved ${r.direction}${r.worse ? ", worse" : ""}` : VERDICT[r.verdict]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RunSource source="drift" label="drift check" />
    </section>
  );
}

const LABEL: Record<string, string> = { lead: "a lead", pain: "pain, not a lead", none: "no pain" };

function Evals({ h }: { h: Health }) {
  const labelled = h.labelled.lead + h.labelled.pain + h.labelled.none;
  const runs = [...h.evals].reverse(); // oldest first for the chart
  const when = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return (
    <section className="card source" aria-labelledby="h-evals" id="evals">
      <div className="source-head">
        <h2 id="h-evals">AI test set</h2>
        <Meta className="source-meta" items={[`${labelled} posts labelled`, `${h.labelled.lead} leads`, `${h.labelled.pain} pain, not a lead`, `${h.labelled.none} no pain`]} />
      </div>
      <p className="muted source-note">
        {labelled === 0 && "No posts labelled yet. On LinkedIn search, Posts tab, give each post your verdict; aim for 50, at least 10 of them leads. "}
        Run <code>npm run eval</code> after any prompt or model change, and weekly: about $0.0004 a post.
      </p>
      {runs.length >= 2 && (
        <LineChart
          title="The AI against your labels, per eval run"
          x={runs.map((e) => when(e.created_at))}
          f="pct"
          series={[
            { key: "lr", label: "Leads found", values: runs.map((e) => e.lead_recall), slot: 1 },
            { key: "lp", label: "Leads right", values: runs.map((e) => e.lead_precision), slot: 2 },
            { key: "pr", label: "Pain found", values: runs.map((e) => e.pain_recall), slot: 3 },
          ]}
        />
      )}
      {runs.length === 1 && <p className="muted">One eval run so far: the chart starts at the second.</p>}
      {h.evals.length > 0 && (
        <div className="runs-wrap">
          <table className="runs health">
            <caption className="sr-only">Eval runs, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Model, prompt</th>
                <th scope="col" className="r">Posts</th>
                <th scope="col" className="r">Pain found</th>
                <th scope="col" className="r">Leads found</th>
                <th scope="col" className="r">Leads right</th>
                <th scope="col" className="r">Agreement</th>
              </tr>
            </thead>
            <tbody>
              {h.evals.slice(0, 8).map((e) => (
                <tr key={e.created_at}>
                  <td>{ageLabel(e.created_at)}</td>
                  <td>
                    {e.model} <span className="muted num">{e.prompt_hash}</span>
                  </td>
                  <td className="r num">{e.cases}</td>
                  <td className="r num">{pct(e.pain_recall)}</td>
                  <td className="r num">{pct(e.lead_recall)}</td>
                  <td className="r num">{pct(e.lead_precision)}</td>
                  <td className="r num">{pct(e.agreement)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {h.disagreements.length > 0 && (
        <>
          <h3 className="health-sub">Where the AI disagreed with you, latest run</h3>
          <ul className="social-list">
            {h.disagreements.map((d, i) => (
              <li key={i} className="social-item">
                <span className="verdict">
                  You: {LABEL[d.label] ?? d.label}. AI: {LABEL[d.ai] ?? d.ai}
                  {d.why !== "card" && d.why !== "no_pain" ? ` (${NOT_A_CARD[d.why]?.toLowerCase() ?? d.why})` : ""}
                </span>
                <p className="muted social-ai">“{d.text.replace(/\s+/g, " ").slice(0, 280)}…”</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
