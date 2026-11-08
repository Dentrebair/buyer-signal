// /trends (§5.6, §10.5): what manual work businesses keep describing, grouped by meaning per
// vertical, from job posts, LinkedIn posts and commenters. No company is named: this is for
// choosing what to pitch and what to search, not for outreach.
import Link from "next/link";
import { ArrowLeft, ChartLineUp } from "@phosphor-icons/react/ssr";
import { TREND_SOURCE_LABEL, type TrendSource, trendDirection } from "@bs/core";
import { Meta } from "@/components/Meta.tsx";
import { RunSource } from "@/components/RunNow.tsx";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { ageLabel, verticalLabel } from "@/lib/labels.ts";
import { loadTrends } from "@/lib/trends.ts";

export const dynamic = "force-dynamic";

const NOUN: Record<TrendSource, [string, string]> = {
  job_post: ["job post", "job posts"],
  li_post: ["LinkedIn post", "LinkedIn posts"],
  li_comment: ["LinkedIn comment", "LinkedIn comments"],
};
const count = (s: TrendSource, n: number) => `${n} ${NOUN[s][n === 1 ? 0 : 1]}`;

const DIRECTION = {
  new: { label: "New this month", className: "badge-tag badge-good" },
  rising: { label: "Rising", className: "badge-tag badge-good" },
  falling: { label: "Falling", className: "badge-tag" },
  steady: { label: "Steady", className: "verdict" },
} as const;

export default async function TrendsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).vertical;
  const vertical = typeof raw === "string" && /^[a-z_]+$/.test(raw) ? raw : null;
  const t = await loadTrends(vertical);
  const nameOf = (v: string | null) => (v ? verticalLabel(v) : "No vertical");
  return (
    <div className="radar">
      <header className="radar-head">
        <Link href="/dashboard" className="radar-back">
          <ArrowLeft size={16} aria-hidden /> Inbox
        </Link>
        <h1>Trends</h1>
        <ThemeToggle />
      </header>

      <main className="radar-main">
        <section className="card source" aria-labelledby="t-about">
          <div className="source-head">
            <h2 id="t-about">
              <ChartLineUp size={18} aria-hidden /> Pains businesses keep describing
            </h2>
            <Meta className="source-meta" items={["Rebuilt Mondays 06:30 UTC", t.builtAt && `Last built ${ageLabel(t.builtAt)}`]} />
          </div>
          <p className="muted source-note">
            {t.statements} pain statements from the last 180 days (
            {(Object.keys(TREND_SOURCE_LABEL) as TrendSource[]).map((s, i) => `${i ? ", " : ""}${count(s, t.bySource[s] ?? 0)}`)}
            ), grouped by meaning within each vertical. A pain seen 3 times or more is named here; {t.ungrouped} statements sit in smaller groups. No
            company or person is named: use it to choose what to pitch and which topics to search.
          </p>
          <RunSource source="trends" label="trends" />
        </section>

        {t.verticals.length > 0 && (
          <nav className="trend-verticals" aria-label="Vertical">
            <Link href="/trends" className={`trend-chip${vertical === null ? " is-current" : ""}`} aria-current={vertical === null ? "true" : undefined}>
              All verticals
            </Link>
            {t.verticals
              .filter((v) => v.trends > 0)
              .map((v) => {
                const key = v.vertical ?? "any";
                return (
                  <Link key={key} href={`/trends?vertical=${key}`} className={`trend-chip${vertical === key ? " is-current" : ""}`} aria-current={vertical === key ? "true" : undefined}>
                    {nameOf(v.vertical)} <span className="num">{v.trends}</span>
                  </Link>
                );
              })}
          </nav>
        )}

        {t.trends.length === 0 ? (
          <p className="muted">No trends yet. Run now builds them from the pain already read.</p>
        ) : (
          <ol className="trends">
            {t.trends.map((x) => {
              const dir = DIRECTION[trendDirection(x.recent, x.previous)];
              return (
                <li key={x.id} className="card trend">
                  <div className="lead-head">
                    <h3 className="trend-label">{x.label}</h3>
                    <span className={dir.className}>{dir.label}</span>
                  </div>
                  <Meta
                    className="source-meta"
                    items={[
                      nameOf(x.vertical),
                      <>
                        Seen <span className="num">{x.size}</span> times
                      </>,
                      <>
                        <span className="num">{x.recent}</span> in the last 30 days, <span className="num">{x.previous}</span> in the 30 before
                      </>,
                      (Object.keys(x.sources) as TrendSource[]).map((s) => count(s, x.sources[s] ?? 0)).join(", "),
                    ]}
                  />
                  {x.summary && <p className="trend-summary">{x.summary}</p>}
                  <details>
                    <summary>What they said ({x.examples.length})</summary>
                    <ul className="trend-examples">
                      {x.examples.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ol>
        )}
      </main>
    </div>
  );
}
