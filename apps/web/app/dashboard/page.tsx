// Triage inbox (PRD §10.1, Q67): queues + filters | ranked list | dossier.
import Link from "next/link";
import { ArrowLeft, ArrowSquareOut, ChartBar, Files, Fire, Flask, Hourglass, Info, Lightning, Percent, Repeat, Robot, Warning, X } from "@phosphor-icons/react/ssr";
import { type ScoreBreakdown, type StructuredIntelligence, boardColumn, sourceFamily } from "@bs/core";
import { ActionBar } from "@/components/ActionBar.tsx";
import { FamilyIcon } from "@/components/FamilyIcon.tsx";
import { FilterSelect } from "@/components/Filters.tsx";
import { RowLink } from "@/components/RowLink.tsx";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { type Company, type Row, type View, QUEUES, loadInbox, parseView, viewHref } from "@/lib/inbox.ts";
import {
  FAMILY_LABEL,
  QUEUE_LABEL,
  REJECT_LABEL,
  SIZE_LABEL,
  SIZE_ORDER,
  SOURCE_LABEL,
  VERTICAL_SHORT,
  ageLabel,
  countryLabel,
  verticalLabel,
} from "@/lib/labels.ts";

export const dynamic = "force-dynamic";

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const view = parseView(await searchParams);
  const inbox = await loadInbox(view);
  const selected = inbox.selected;
  const index = selected ? inbox.rows.findIndex((r) => r.id === selected.id) : -1;
  const next = index >= 0 ? (inbox.rows[index + 1] ?? inbox.rows[index - 1] ?? null) : null;
  const hasSample = inbox.rows.some((r) => r.is_sample) || selected?.is_sample;
  const filtered = Boolean(view.vertical || view.country || view.size);

  return (
    <div className="app" data-view={view.id ? "detail" : "list"}>
      <aside className="sidebar" aria-label="Queues and filters">
        <div className="brand">
          <span className="brand-name">Buying Signal</span>
          <ThemeToggle />
        </div>

        <nav aria-label="Queues">
          <ul className="queues">
            {QUEUES.map((q) => (
              <li key={q}>
                <Link href={viewHref(view, { queue: q, id: null })} className="queue" aria-current={view.queue === q ? "page" : undefined}>
                  <span>{QUEUE_LABEL[q]}</span>
                  <span className="queue-count num">{inbox.counts[q]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="filters" role="group" aria-label="Filters">
          <FilterSelect
            name="vertical"
            label="Vertical"
            options={inbox.options.verticals.map((v) => ({ value: v, label: verticalLabel(v) })).sort((a, b) => a.label.localeCompare(b.label))}
          />
          <FilterSelect name="country" label="Country" options={inbox.options.countries.map((c) => ({ value: c, label: countryLabel(c) }))} />
          <FilterSelect
            name="size"
            label="Size"
            options={SIZE_ORDER.filter((s) => inbox.options.sizes.includes(s)).map((s) => ({ value: s, label: SIZE_LABEL[s] }))}
          />
          {filtered && (
            <Link href={viewHref(view, { vertical: null, country: null, size: null, id: null })} className="clear-filters">
              Clear filters
            </Link>
          )}
        </div>

        {hasSample && (
          <p className="sample-note">
            <Flask size={14} aria-hidden />
            <span>
              <strong>Sample data.</strong> Sprint 0 posts older than 21 days — for testing, not real leads.
            </span>
          </p>
        )}
      </aside>

      <section className="list" aria-labelledby="list-title">
        <header className="list-head">
          <h1 id="list-title">
            {QUEUE_LABEL[view.queue]} <span className="num muted">{inbox.rows.length}</span>
          </h1>
          <div className="segmented" role="group" aria-label="Sort">
            <Link href={viewHref(view, { sort: "score" })} aria-current={view.sort === "score" ? "true" : undefined}>
              Score
            </Link>
            <Link href={viewHref(view, { sort: "newest" })} aria-current={view.sort === "newest" ? "true" : undefined}>
              Newest
            </Link>
          </div>
        </header>
        {inbox.rows.length === 0 ? (
          <div className="empty">
            <p>{emptyText(view, filtered)}</p>
            {filtered && (
              <Link href={viewHref(view, { vertical: null, country: null, size: null, id: null })} className="btn">
                Clear filters
              </Link>
            )}
          </div>
        ) : (
          <ul className="rows">
            {inbox.rows.map((r) => (
              <li key={r.id}>
                <ListRow row={r} href={viewHref(view, { id: r.id })} current={r.id === selected?.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="detail" aria-label="Company dossier">
        {selected ? (
          <Dossier
            company={selected}
            view={view}
            nextHref={viewHref(view, { id: next?.id ?? null })}
            selfHref={viewHref(view, { id: selected.id })}
          />
        ) : (
          <div className="empty">
            <p>Pick a company from the list to see its pain, pitch and evidence.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function emptyText(view: View, filtered: boolean): string {
  if (filtered) return "No companies match these filters.";
  return {
    triage: "Nothing to triage. Companies scoring above 70 land here.",
    nurture: "Nothing in Nurture. Companies scoring 50–70 land here.",
    sent: "Nothing sent yet. Companies you mark as sent move here.",
    rejected: "Nothing rejected.",
  }[view.queue];
}

function ListRow({ row, href, current }: { row: Row; href: string; current: boolean }) {
  const meta = [
    row.country?.toUpperCase(),
    row.vertical ? VERTICAL_SHORT[row.vertical] : null,
    row.size_tier && row.size_tier !== "unknown" ? SIZE_LABEL[row.size_tier] : null,
    row.hours ? `~${row.hours} h/wk` : null,
  ].filter(Boolean);
  return (
    <RowLink href={href} current={current}>
      <span className="row-top">
        <span className="row-name">{row.company_name ?? row.domain}</span>
        <span className={`score-pill num tier-${tier(row.priority_score)}`}>{row.priority_score}</span>
      </span>
      {row.symptom && <span className="row-pain">{row.symptom}</span>}
      <span className="row-meta">
        <span className="row-meta-text">{meta.join(" · ")}</span>
        <span className="row-icons">
          {row.families.map((f) => (
            <FamilyIcon key={f} family={f} size={14} />
          ))}
        </span>
      </span>
    </RowLink>
  );
}

// Colour tier from the same thresholds as the queues (§10.1).
// With status "new", boardColumn only returns a score tier.
const tier = (score: number) => boardColumn(score, "new") as "triage" | "nurture" | "hidden";

function Dossier({ company: c, view, nextHref, selfHref }: { company: Company; view: View; nextHref: string; selfHref: string }) {
  const b = c.score_breakdown;
  const best = c.challenges.find((ch) => ch.id === b?.best_signal_id) ?? c.challenges[0];
  const si = best?.structured_intelligence ?? null;
  const status =
    c.status === "actioned" ? "Sent" : c.status === "rejected" ? "Rejected" : { triage: "Triage", nurture: "Nurture", hidden: "Hidden" }[tier(c.priority_score)];

  return (
    <>
      <div className="detail-scroll">
        <article className="dossier">
          <Link href={viewHref(view, { id: null })} className="back">
            <ArrowLeft size={16} aria-hidden /> {QUEUE_LABEL[view.queue]}
          </Link>

          <header className="d-head">
            <div className="d-title">
              <h2>{c.company_name ?? c.domain}</h2>
              <a href={`https://${c.domain}`} target="_blank" rel="noopener noreferrer" className="d-domain">
                {c.domain} <ArrowSquareOut size={13} aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
              <p className="d-meta">
                {countryLabel(c.country)} · {verticalLabel(c.vertical)} · {SIZE_LABEL[c.size_tier ?? "unknown"]}
                {c.employee_band ? ` (${c.employee_band})` : ""}
              </p>
            </div>
            <div className={`d-score tier-${tier(c.priority_score)}`}>
              <span className="d-score-num num">{c.priority_score}</span>
              <span className="d-score-label">{status}</span>
            </div>
          </header>

          <Notices company={c} />

          <section className="card tone-red" aria-labelledby="pain">
            <h3 id="pain">
              <Fire size={15} aria-hidden /> The pain
            </h3>
            {si ? (
              <>
                <p className="symptom">{si.verified_symptom}</p>
                <dl className="stats">
                  <Stat tone="blue" icon={<Repeat size={16} aria-hidden />} label="Happens" value={si.blast_radius.frequency} />
                  <Stat
                    tone={si.blast_radius.urgency_level === "Blocking" ? "red" : "amber"}
                    icon={<Lightning size={16} aria-hidden />}
                    label="Urgency"
                    value={si.blast_radius.urgency_level}
                  />
                  <Stat tone="violet" icon={<Hourglass size={16} aria-hidden />} label="Time lost" value={`~${si.blast_radius.estimated_hours_wasted_weekly} h/week`} />
                  <Stat
                    tone="green"
                    icon={<Percent size={16} aria-hidden />}
                    label="Automatable"
                    value={si.automatable_task_percentage === null ? "—" : `${si.automatable_task_percentage}%`}
                  />
                </dl>
                <p className="d-sub">
                  {si.department}
                  {si.inferred_tech_stack.length > 0 && <> · Uses {si.inferred_tech_stack.join(", ")}</>}
                  {si.blast_radius.founder_dependency_flag && <> · Owner is the bottleneck</>}
                </p>
              </>
            ) : (
              <p className="muted">No extracted pain on this company's signals yet.</p>
            )}
          </section>

          {si?.proposed_ai_replacement && (
            <section className="card tone-green pitch" aria-labelledby="pitch">
              <h3 id="pitch">
                <Robot size={15} aria-hidden /> What to pitch
              </h3>
              <p>{si.proposed_ai_replacement}</p>
            </section>
          )}

          {b && best && <ScoreWhy breakdown={b} si={si} total={c.priority_score} source={SOURCE_LABEL[best.source_type]} />}

          <section className="tone-blue" aria-labelledby="evidence">
            <h3 id="evidence" className="section-title">
              <Files size={15} aria-hidden /> Evidence <span className="num">{c.challenges.length}</span>
            </h3>
            <ul className="evidence">
              {c.challenges.map((ch) => {
                const [title, ...rest] = ch.evidence_snippet.split("\n\n");
                const family = sourceFamily(ch.source_type);
                return (
                  <li key={ch.id} className="card ev">
                    <div className="ev-head">
                      <FamilyIcon family={family} labelled={false} />
                      <span className="ev-title">{title}</span>
                    </div>
                    <p className="ev-meta">
                      {SOURCE_LABEL[ch.source_type]} · {ageLabel(ch.posted_at)} · signal <span className="num">{ch.signal_score}</span>
                      {ch.source_url && /^https?:\/\//i.test(ch.source_url) && (
                        <>
                          {" · "}
                          <a href={ch.source_url} target="_blank" rel="noopener noreferrer" className="link">
                            Open original <ArrowSquareOut size={12} aria-hidden />
                            <span className="sr-only">(opens in a new tab)</span>
                          </a>
                        </>
                      )}
                    </p>
                    {ch.author_relation !== "employee" && rest.length > 0 && (
                      <details>
                        <summary>Read the post</summary>
                        <div className="ev-text">{rest.join("\n\n")}</div>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <p className="later">
            <Info size={14} aria-hidden /> Website audit and email drafts are added in Sprints 2–3.
          </p>
        </article>
      </div>
      <ActionBar id={c.id} domain={c.company_name ?? c.domain} status={c.status} nextHref={nextHref} selfHref={selfHref} />
    </>
  );
}

type Tone = "blue" | "red" | "amber" | "violet" | "green";

function Stat({ label, value, icon, tone }: { label: string; value: string; icon?: React.ReactNode; tone: Tone }) {
  return (
    <div className={`stat tone-${tone}`}>
      <dt>{label}</dt>
      <dd>
        {icon}
        {value}
      </dd>
    </div>
  );
}

function Notices({ company: c }: { company: Company }) {
  const items: { icon: React.ReactNode; text: React.ReactNode; warn?: boolean }[] = [];
  if (c.status === "rejected" && c.rejection_reason)
    items.push({ icon: <X size={14} aria-hidden />, text: <>Rejected: {REJECT_LABEL[c.rejection_reason as keyof typeof REJECT_LABEL] ?? c.rejection_reason}</> });
  if (c.score_breakdown?.M === 0)
    items.push({
      icon: <Warning size={14} aria-hidden />,
      text: (
        <>
          <strong>Single signal.</strong> Nothing else confirms this pain yet — check the post before reaching out.
        </>
      ),
      warn: true,
    });
  if (c.is_sample) items.push({ icon: <Flask size={14} aria-hidden />, text: "Sample data — not a live lead." });
  if (!items.length) return null;
  return (
    <ul className="notices">
      {items.map((n, i) => (
        <li key={i} className={n.warn ? "warn" : undefined}>
          {n.icon}
          <span>{n.text}</span>
        </li>
      ))}
    </ul>
  );
}

// §7 in plain words: evidence from the best signal + pain severity (B) + corroboration (M).
function ScoreWhy({ breakdown: b, si, total, source }: { breakdown: ScoreBreakdown; si: StructuredIntelligence | null; total: number; source: string }) {
  if (b.override === "inbound") {
    return (
      <section className="card tone-violet" aria-labelledby="why">
        <h3 id="why">
          <ChartBar size={15} aria-hidden /> Why {total}
        </h3>
        <p className="muted">The company asked for a review through /roast, which always scores 100.</p>
      </section>
    );
  }
  const h = si?.blast_radius;
  const parts = h
    ? [
        `${h.frequency} +${{ Daily: 10, Weekly: 5, Sporadic: 0 }[h.frequency]}`,
        `${h.urgency_level} +${h.urgency_level === "Blocking" ? 10 : 3}`,
        `owner bottleneck +${h.founder_dependency_flag ? 10 : 0}`,
      ].join(" · ")
    : null;
  const base = total - b.B - b.M;
  return (
    <section className="card tone-violet" aria-labelledby="why">
      <h3 id="why">
        <ChartBar size={15} aria-hidden /> Why {total}
      </h3>
      <dl className="why">
        <div>
          <dt>{source} evidence</dt>
          <dd className="num">{base}</dd>
        </div>
        <div>
          <dt>
            Pain severity{parts && <span className="muted"> — {parts}</span>}
          </dt>
          <dd className="num">+{b.B}</dd>
        </div>
        <div>
          <dt>
            Confirmed by other sources{" "}
            <span className="muted">— {b.families.length === 1 ? `only ${FAMILY_LABEL[b.families[0]!]}` : b.families.map((f) => FAMILY_LABEL[f]).join(", ")}</span>
          </dt>
          <dd className="num">+{b.M}</dd>
        </div>
      </dl>
    </section>
  );
}
