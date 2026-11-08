// Triage inbox (PRD §10.1, Q67): queues + filters | ranked list | dossier.
import Link from "next/link";
import { ArrowLeft, ArrowSquareOut, ChartBar, Files, Fire, Flask, GlobeSimpleX, Info, MagnifyingGlass, Robot, Warning, X } from "@phosphor-icons/react/ssr";
import { type ScoreBreakdown, type SourceFamily, type StructuredIntelligence, boardColumn, sourceFamily } from "@bs/core";
import { ActionBar } from "@/components/ActionBar.tsx";
import { FamilyIcon } from "@/components/FamilyIcon.tsx";
import { PostLink } from "@/components/PostLink.tsx";
import { FilterSelect } from "@/components/Filters.tsx";
import { Facts, Meta } from "@/components/Meta.tsx";
import { RowLink } from "@/components/RowLink.tsx";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { WebsiteAudit } from "@/components/WebsiteAudit.tsx";
import { healthValue, movedNumbers } from "@/lib/health.ts";
import { type Company, type CompanyCheckView, type Row, type View, QUEUES, loadInbox, parseView, viewHref } from "@/lib/inbox.ts";
import {
  FAMILY_LABEL,
  PRODUCT_LABEL,
  PRODUCT_LAYERS,
  QUEUE_LABEL,
  REJECT_LABEL,
  SCOPES,
  SCOPE_LABEL,
  SIZE_LABEL,
  SIZE_ORDER,
  SOURCE_LABEL,
  URGENCY_LABEL,
  URGENCY_TIERS,
  type UrgencyTier,
  VERTICAL_SHORT,
  ageLabel,
  countryLabel,
  scopeOf,
  verticalLabel,
} from "@/lib/labels.ts";

export const dynamic = "force-dynamic";

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const view = parseView(await searchParams);
  const [inbox, moved] = await Promise.all([loadInbox(view), movedNumbers()]);
  const selected = inbox.selected;
  const index = selected ? inbox.rows.findIndex((r) => r.id === selected.id) : -1;
  const next = index >= 0 ? (inbox.rows[index + 1] ?? inbox.rows[index - 1] ?? null) : null;
  const hasSample = inbox.rows.some((r) => r.is_sample) || selected?.is_sample;
  const filtered = Boolean(view.vertical || view.country || view.size || view.scope || view.urgency || view.layer);

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

        <Link href="/radar" className="queue sources-link">
          <span>Sources</span>
          <span className="queue-count">Run now</span>
        </Link>
        <Link href="/linkedin" className="queue">
          <span>LinkedIn search</span>
        </Link>
        {moved.length > 0 && (
          <Link href="/radar#src-health" className={`health-alert${moved[0]!.worse ? " is-worse" : ""}`}>
            <Warning size={16} aria-hidden />
            <span>
              <strong>
                {moved.length === 1 ? "A health number moved" : `${moved.length} health numbers moved`} this week.
              </strong>{" "}
              {moved[0]!.label}: {healthValue(moved[0]!, moved[0]!.base)} before, {healthValue(moved[0]!, moved[0]!.window)} now.
            </span>
          </Link>
        )}

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
          <FilterSelect name="urgency" label="Urgency" options={URGENCY_TIERS.map((t) => ({ value: t, label: URGENCY_LABEL[t] }))} />
          <FilterSelect name="layer" label="Pitch" options={PRODUCT_LAYERS.map((l) => ({ value: l, label: PRODUCT_LABEL[l] }))} />
          <FilterSelect name="scope" label="Automation" options={SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] }))} />
          {filtered && (
            <Link href={viewHref(view, { vertical: null, country: null, size: null, scope: null, urgency: null, layer: null, id: null })} className="clear-filters">
              Clear filters
            </Link>
          )}
        </div>

        {hasSample && (
          <p className="sample-note">
            <Flask size={14} aria-hidden />
            <span>
              <strong>Sample data.</strong> Sprint 0 posts older than 21 days, for testing, not real leads.
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
              <Link href={viewHref(view, { vertical: null, country: null, size: null, scope: null, urgency: null, layer: null, id: null })} className="btn">
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
  return (
    <RowLink href={href} current={current}>
      <span className="row-top">
        <span className="row-name">{displayName(row)}</span>
        <span className={`score-pill num tier-${tier(row.priority_score)}`}>{row.priority_score}</span>
      </span>
      {row.symptom && <span className="row-pain">{row.symptom}</span>}
      <span className="row-tags">
        <UrgencyTag tier={row.urgency} />
        {row.product_layer && <span className={`layer-tag layer-${row.product_layer}`}>{PRODUCT_LABEL[row.product_layer]}</span>}
        <ScopeTag pct={row.automatable_pct} />
      </span>
      <span className="row-meta">
        <Facts
          className="row-meta-text"
          items={[
            ["country", row.country?.toUpperCase()],
            ["vertical", row.vertical && VERTICAL_SHORT[row.vertical]],
            ["size", row.size_tier && row.size_tier !== "unknown" && SIZE_LABEL[row.size_tier]],
            ["nosite", !row.domain && "No website"],
            ["hours", row.hours ? `~${row.hours} h/wk` : null],
          ]}
        />
        <span className="row-icons">
          {uniqueByLabel(row.families).map((f) => (
            <FamilyIcon key={f} family={f} size={14} />
          ))}
        </span>
      </span>
    </RowLink>
  );
}

// Urgency tier (§1.1): always in words, so it never relies on colour alone.
function UrgencyTag({ tier: t }: { tier: UrgencyTier | null }) {
  if (!t) return null;
  return <span className={`urgency-tag urgency-${t}`}>{URGENCY_LABEL[t]}</span>;
}

// "Full automation 75%" / "Partial automation 50%"; nothing when no post was extracted.
function ScopeTag({ pct }: { pct: number | null }) {
  const scope = scopeOf(pct);
  if (!scope) return null;
  return (
    <span className={`scope-tag scope-${scope}`}>
      {SCOPE_LABEL[scope]} <span className="num">{pct}%</span>
    </span>
  );
}

// LinkedIn and Reddit both read "Social digest": show it once.
const uniqueByLabel = (families: SourceFamily[]) => families.filter((f, i) => families.findIndex((g) => FAMILY_LABEL[g] === FAMILY_LABEL[f]) === i);

const displayName = (r: Row) => r.company_name ?? r.domain ?? "Unnamed company";

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
              <h2>{displayName(c)}</h2>
              {c.domain ? (
                <a href={`https://${c.domain}`} target="_blank" rel="noopener noreferrer" className="d-domain">
                  {c.domain} <ArrowSquareOut size={13} aria-hidden />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ) : (
                <span className="d-domain no-site">
                  <GlobeSimpleX size={14} aria-hidden /> No website
                </span>
              )}
              <Facts
                className="d-meta"
                items={[
                  ["country", countryLabel(c.country)],
                  ["vertical", verticalLabel(c.vertical)],
                  ["size", `${SIZE_LABEL[c.size_tier ?? "unknown"]}${c.employee_band ? ` (${c.employee_band})` : ""}`],
                ]}
              />
              <span className="row-tags">
                <UrgencyTag tier={c.urgency} />
                {c.product_layer && <span className={`layer-tag layer-${c.product_layer}`}>Pitch: {PRODUCT_LABEL[c.product_layer]}</span>}
              </span>
            </div>
            <div className={`d-score tier-${tier(c.priority_score)}`}>
              <span className="d-score-num num">{c.priority_score}</span>
              <span className="d-score-label">{status}</span>
            </div>
          </header>

          <Notices company={c} />

          <section className="card" aria-labelledby="pain">
            <h3 id="pain">
              <Fire size={15} aria-hidden /> The pain
            </h3>
            {si ? (
              <>
                <p className="symptom">{si.verified_symptom}</p>
                <dl className="stats">
                  <Stat label="Happens" value={si.blast_radius.frequency} />
                  <Stat label="Impact" value={si.blast_radius.urgency_level} className={`impact-${si.blast_radius.urgency_level.toLowerCase()}`} />
                  <Stat
                    label="Time lost"
                    value={
                      <>
                        <span className="num">~{si.blast_radius.estimated_hours_wasted_weekly}</span> h/week
                      </>
                    }
                  />
                  <Stat
                    label={scopeOf(si.automatable_task_percentage) === "full" ? "Full automation" : "Automatable"}
                    value={
                      si.automatable_task_percentage === null ? (
                        "Not stated"
                      ) : (
                        <>
                          <span className="num">{si.automatable_task_percentage}%</span> of duties
                        </>
                      )
                    }
                  />
                </dl>
                <Meta
                  className="d-sub"
                  items={[
                    si.department,
                    si.inferred_tech_stack.length > 0 && `Uses ${si.inferred_tech_stack.join(", ")}`,
                    si.blast_radius.founder_dependency_flag && "Owner is the bottleneck",
                  ]}
                />
              </>
            ) : (
              <p className="muted">No extracted pain on this company’s signals yet.</p>
            )}
          </section>

          {si?.proposed_ai_replacement && (
            <section className="card pitch" aria-labelledby="pitch">
              <h3 id="pitch">
                <Robot size={15} aria-hidden /> What to pitch
                {si.product_layer && <span className={`layer-tag layer-${si.product_layer}`}>{PRODUCT_LABEL[si.product_layer]}</span>}
              </h3>
              <p>{si.proposed_ai_replacement}</p>
            </section>
          )}

          {c.company_check && <CompanyCheckCard check={c.company_check} />}

          {b && best && <ScoreWhy breakdown={b} si={si} total={c.priority_score} source={SOURCE_LABEL[best.source_type]} />}

          <section className="section" aria-labelledby="evidence">
            <h3 id="evidence" className="section-title">
              <Files size={15} aria-hidden /> Evidence <span className="num">{c.challenges.length}</span>
            </h3>
            <ul className="evidence">
              {c.challenges.map((ch) => {
                const [title, ...rest] = ch.evidence_snippet.split("\n\n");
                const family = sourceFamily(ch.source_type);
                const url = ch.source_url && /^https?:\/\//i.test(ch.source_url) ? ch.source_url : null;
                const social = family === "linkedin_post" || family === "social_post";
                return (
                  <li key={ch.id} className={`ev${social && url ? " ev-social" : ""}`}>
                    {social && url && <PostLink url={url} sourceType={ch.source_type} id={`post-${ch.id}`} />}
                    <div className="ev-head">
                      <FamilyIcon family={family} labelled={false} />
                      <span className="ev-title">{title}</span>
                    </div>
                    <Meta
                      className="ev-meta"
                      items={[
                        SOURCE_LABEL[ch.source_type],
                        ch.urgency_tier && URGENCY_LABEL[ch.urgency_tier],
                        ch.structured_intelligence?.stance === "implied" && (
                          <span title="An upbeat or neutral post that shows manual work; the pain is inferred, so it scores lower">Implied</span>
                        ),
                        ch.structured_intelligence?.stance === "solved" &&
                          { by_hand: "Solved by labor", partly: "Partly solved", with_software: "Already automating" }[ch.structured_intelligence.solved_how ?? "by_hand"],
                        ageLabel(ch.posted_at),
                        <>
                          Signal <span className="num">{ch.signal_score}</span>
                        </>,
                        url && !social && (
                          <a href={url} target="_blank" rel="noopener noreferrer" className="link">
                            Open original <ArrowSquareOut size={12} aria-hidden />
                            <span className="sr-only">(opens in a new tab)</span>
                          </a>
                        ),
                      ]}
                    />
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

          {c.domain && <WebsiteAudit company={c} />}

          <p className="later">
            <Info size={14} aria-hidden /> Email drafts are added in Sprint 3.
          </p>
        </article>
      </div>
      <ActionBar id={c.id} domain={displayName(c)} status={c.status} nextHref={nextHref} selfHref={selfHref} />
    </>
  );
}

const MATCH_LABEL = { yes: "Yes", no: "No", unsure: "Not sure" } as const;
const SIZE_BAND_LABEL = { "1-10": "1 to 10 people", "11-50": "11 to 50 people", "51-200": "51 to 200 people", "200+": "Over 200 people", unknown: "Not found" } as const;

// What the company-check agent found (PRD §5.1a). It never drops a card; a mismatch is for the operator to judge.
function CompanyCheckCard({ check }: { check: CompanyCheckView }) {
  const off = check.sizeBand === "200+" || check.verticalMatch === "no" || check.placeMatch === "no";
  const evidence = check.sizeEvidenceUrl && /^https?:\/\//i.test(check.sizeEvidenceUrl) ? check.sizeEvidenceUrl : null;
  return (
    <section className={`card check${off ? " check-off" : ""}`} aria-labelledby="check">
      <h3 id="check">
        <MagnifyingGlass size={15} aria-hidden /> Company check
      </h3>
      {check.summary && <p>{check.summary}</p>}
      <dl className="stats">
        <Stat
          label="Size"
          value={
            evidence ? (
              <a href={evidence} target="_blank" rel="noopener noreferrer">
                {SIZE_BAND_LABEL[check.sizeBand]}
                <span className="sr-only"> (source, opens in a new tab)</span>
              </a>
            ) : (
              SIZE_BAND_LABEL[check.sizeBand]
            )
          }
          className={check.sizeBand === "200+" ? "match-no" : undefined}
        />
        <Stat label="In this vertical" value={MATCH_LABEL[check.verticalMatch]} className={`match-${check.verticalMatch}`} />
        <Stat label="In this place" value={MATCH_LABEL[check.placeMatch]} className={`match-${check.placeMatch}`} />
      </dl>
      {off && (
        <p className="check-warn">
          <Warning size={14} aria-hidden /> This may not be the right kind of company. Check before reaching out.
        </p>
      )}
      <Meta className="d-sub" items={[`Checked by AI in ${check.steps} ${check.steps === 1 ? "step" : "steps"}`, `$${check.costUsd.toFixed(3)}`]} />
    </section>
  );
}

function Stat({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd className={className}>{value}</dd>
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
          <strong>Single signal.</strong> Nothing else confirms this pain yet. Check the post before reaching out.
        </>
      ),
      warn: true,
    });
  if (!c.domain)
    items.push({
      icon: <GlobeSimpleX size={14} aria-hidden />,
      text: (
        <>
          <strong>No website found.</strong> Pitch the hiring need in this post, not website work. Reach them through the job post.
        </>
      ),
    });
  if (c.is_client_rendered)
    items.push({
      icon: <Warning size={14} aria-hidden />,
      text: (
        <>
          <strong>Client-rendered site.</strong> The website audit could only see an empty page shell.
        </>
      ),
      warn: true,
    });
  if (c.is_sample) items.push({ icon: <Flask size={14} aria-hidden />, text: "Sample data, not a live lead." });
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
      <section className="card" aria-labelledby="why">
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
      ].join(", ")
    : null;
  const base = total - b.B - b.M;
  return (
    <section className="card" aria-labelledby="why">
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
            Pain severity{parts && <span className="muted"> ({parts})</span>}
          </dt>
          <dd className="num">+{b.B}</dd>
        </div>
        <div>
          <dt>
            Confirmed by other sources{" "}
            <span className="muted">({b.families.length === 1 ? `only ${FAMILY_LABEL[b.families[0]!]}` : uniqueByLabel(b.families).map((f) => FAMILY_LABEL[f]).join(", ")})</span>
          </dt>
          <dd className="num">+{b.M}</dd>
        </div>
      </dl>
    </section>
  );
}
