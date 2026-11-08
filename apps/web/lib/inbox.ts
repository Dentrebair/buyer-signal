// Inbox queries (PRD §10.1). Queues and filters come from the URL so a view can be bookmarked.
import type { OutreachDrafts, ScoreBreakdown, SizeTier, SourceFamily, SourceType, StructuredIntelligence } from "@bs/core";
import type { AuditCompany } from "@/components/WebsiteAudit.tsx";
import { FULL_AUTOMATION_PCT, PRODUCT_LAYERS, SCOPES, type Scope, URGENCY_TIERS, type UrgencyTier } from "./labels.ts";
import { asOperator } from "./operator.ts";

export const QUEUES = ["triage", "nurture", "sent", "rejected"] as const;
export type Queue = (typeof QUEUES)[number];

export interface View {
  queue: Queue;
  sort: "score" | "newest";
  vertical: string | null;
  country: string | null;
  size: SizeTier | null;
  scope: Scope | null;
  urgency: UrgencyTier | null;
  layer: (typeof PRODUCT_LAYERS)[number] | null;
  id: string | null;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || null;

export function parseView(sp: Record<string, string | string[] | undefined>): View {
  const queue = one(sp.q) as Queue | null;
  return {
    queue: queue && QUEUES.includes(queue) ? queue : "triage",
    sort: one(sp.sort) === "newest" ? "newest" : "score",
    vertical: one(sp.vertical),
    country: one(sp.country),
    size: one(sp.size) as SizeTier | null,
    scope: SCOPES.find((s) => s === one(sp.scope)) ?? null,
    urgency: URGENCY_TIERS.find((t) => t === one(sp.urgency)) ?? null,
    layer: PRODUCT_LAYERS.find((l) => l === one(sp.layer)) ?? null,
    id: one(sp.id),
  };
}

export function viewHref(v: View, patch: Partial<View> = {}): string {
  const x = { ...v, ...patch };
  const p = new URLSearchParams();
  p.set("q", x.queue);
  if (x.sort !== "score") p.set("sort", x.sort);
  if (x.vertical) p.set("vertical", x.vertical);
  if (x.country) p.set("country", x.country);
  if (x.size) p.set("size", x.size);
  if (x.scope) p.set("scope", x.scope);
  if (x.urgency) p.set("urgency", x.urgency);
  if (x.layer) p.set("layer", x.layer);
  if (x.id) p.set("id", x.id);
  return `/dashboard?${p}`;
}

// The company's largest automatable share across its extracted signals (job posts).
const PCT_SQL = "(select max((ch.structured_intelligence ->> 'automatable_task_percentage')::int) from challenges ch where ch.company_id = c.id)";

// The company's most urgent signal tier (§1.1), and the product to pitch from its strongest
// signal that names one.
const URGENCY_SQL = `(select (array['high','medium','low'])[min(array_position(array['high','medium','low'], ch.urgency_tier))]
   from challenges ch where ch.company_id = c.id)`;
const LAYER_SQL = `(select ch.structured_intelligence ->> 'product_layer' from challenges ch
   where ch.company_id = c.id and ch.structured_intelligence ->> 'product_layer' is not null order by ch.signal_score desc limit 1)`;

// §10.1: Triage > 70, Nurture 50–70, hidden < 50 (never listed here).
const QUEUE_SQL: Record<Queue, string> = {
  triage: "c.status = 'new' and c.priority_score > 70",
  nurture: "c.status = 'new' and c.priority_score between 50 and 70",
  sent: "c.status = 'actioned'",
  rejected: "c.status = 'rejected'",
};

export interface Row {
  id: string;
  domain: string | null; // null = no website found
  company_name: string | null;
  vertical: string | null;
  country: string | null;
  size_tier: SizeTier | null;
  priority_score: number;
  score_breakdown: ScoreBreakdown;
  is_sample: boolean;
  families: SourceFamily[];
  symptom: string | null; // best signal's verified_symptom
  hours: number | null; // best signal's estimated hours wasted per week
  automatable_pct: number | null; // largest automatable share across its signals
  urgency: UrgencyTier | null; // most urgent signal tier
  product_layer: (typeof PRODUCT_LAYERS)[number] | null; // what to pitch first
}

export interface Challenge {
  id: string;
  source_type: SourceType;
  source_url: string | null;
  signal_score: number;
  evidence_confidence: number;
  buying_intent: number;
  blast_radius: number;
  department: string;
  posted_at: string | null;
  created_at: string;
  evidence_snippet: string;
  structured_intelligence: StructuredIntelligence | null;
  llm_model: string | null;
  author_relation: string | null;
  urgency_tier: UrgencyTier | null;
}

export interface Company extends Row {
  status: "new" | "actioned" | "rejected";
  rejection_reason: string | null;
  employee_band: string | null;
  size_source: string | null;
  tech_stack: AuditCompany["tech_stack"];
  reachable: boolean | null;
  is_client_rendered: boolean;
  last_sniffed_at: string | null;
  web_ui_audit_flags: AuditCompany["web_ui_audit_flags"];
  contact_email: string | null;
  contact_whatsapp: string | null;
  contact_source_url: string | null;
  actioned_at: string | null;
  company_check: CompanyCheckView | null;
  challenges: Challenge[];
  // Email drafts (§9): the last ones written, whether newer evidence has arrived since, and the
  // latest Create drafts click (still writing, done or failed).
  outreach_drafts: OutreachDrafts | null;
  draft_stale: boolean;
  draft_generated_at: string | null;
  draft_request: { status: "queued" | "done" | "error"; error: string | null; model: string | null; cost_usd: number | null; requested_at: string } | null;
}

// What the company-check agent found (PRD §5.1a), as stored on the company.
export interface CompanyCheckView {
  domain: string | null;
  sizeBand: "1-10" | "11-50" | "51-200" | "200+" | "unknown";
  sizeEvidenceUrl: string | null;
  verticalMatch: "yes" | "no" | "unsure";
  placeMatch: "yes" | "no" | "unsure";
  summary: string;
  steps: number;
  costUsd: number;
  checkedAt: string;
}

export interface Inbox {
  counts: Record<Queue, number>;
  rows: Row[];
  options: { verticals: string[]; countries: string[]; sizes: SizeTier[] };
  selected: Company | null;
}

export function loadInbox(view: View): Promise<Inbox> {
  return asOperator(async (c) => {
    const params: unknown[] = [];
    const filters: string[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      filters.push(sql.replace("?", `$${params.length}`));
    };
    if (view.vertical) add("c.vertical = ?", view.vertical);
    if (view.country) add("c.country = ?", view.country);
    if (view.size) add("c.size_tier = ?", view.size);
    if (view.scope) add(`${PCT_SQL} ${view.scope === "full" ? ">=" : "<"} ?`, FULL_AUTOMATION_PCT);
    if (view.urgency) add(`${URGENCY_SQL} = ?`, view.urgency);
    if (view.layer) add(`${LAYER_SQL} = ?`, view.layer);
    const where = filters.length ? ` and ${filters.join(" and ")}` : "";

    const counts = Object.fromEntries(QUEUES.map((q) => [q, 0])) as Record<Queue, number>;
    const countSql = QUEUES.map((q) => `count(*) filter (where ${QUEUE_SQL[q]})::int as ${q}`).join(", ");
    const cr = (await c.query(`select ${countSql} from companies c where true${where}`, params)).rows[0];
    for (const q of QUEUES) counts[q] = cr?.[q] ?? 0;

    // Ties on score (common: B has few values) break on hours lost, the next-best urgency signal.
    const order =
      view.sort === "newest"
        ? "newest desc nulls last, c.priority_score desc"
        : "c.priority_score desc, hours desc nulls last, newest desc nulls last, c.domain";
    const rows = (
      await c.query<Row>(
        `select c.id, c.domain, c.company_name, c.vertical, c.country, c.size_tier, c.priority_score,
                c.score_breakdown, c.is_sample,
                coalesce((select array_agg(distinct ch.source_family) from challenges ch where ch.company_id = c.id), '{}') as families,
                (select max(coalesce(ch.posted_at, ch.created_at)) from challenges ch where ch.company_id = c.id) as newest,
                best.si ->> 'verified_symptom' as symptom,
                (best.si -> 'blast_radius' ->> 'estimated_hours_wasted_weekly')::int as hours,
                ${PCT_SQL} as automatable_pct,
                ${URGENCY_SQL} as urgency,
                ${LAYER_SQL} as product_layer
           from companies c
           left join lateral (
             select ch.structured_intelligence as si from challenges ch
              where ch.id = nullif(c.score_breakdown ->> 'best_signal_id', '')::uuid
           ) best on true
          where ${QUEUE_SQL[view.queue]}${where}
          order by ${order}
          limit 500`,
        params,
      )
    ).rows;

    const opt = (
      await c.query<{ verticals: string[] | null; countries: string[] | null; sizes: SizeTier[] | null }>(
        `select array_agg(distinct vertical) filter (where vertical is not null) verticals,
                array_agg(distinct country) filter (where country is not null) countries,
                array_agg(distinct size_tier) filter (where size_tier is not null) sizes
           from companies where status <> 'new' or priority_score >= 50`,
      )
    ).rows[0];

    // No company picked → the top of the list, so a review starts straight away (desktop).
    const selectedId = view.id ?? rows[0]?.id ?? null;
    let selected: Company | null = null;
    if (selectedId && /^[0-9a-f-]{36}$/.test(selectedId)) {
      const co = (
        await c.query(
          `select c.*, coalesce((select array_agg(distinct ch.source_family) from challenges ch where ch.company_id = c.id), '{}') as families,
                  ${URGENCY_SQL} as urgency, ${LAYER_SQL} as product_layer
             from companies c where c.id = $1`,
          [selectedId],
        )
      ).rows[0];
      if (co) {
        const challenges = (
          await c.query<Challenge>(
            `select id, source_type, source_url, signal_score, evidence_confidence, buying_intent, blast_radius, department,
                    posted_at, created_at, evidence_snippet, structured_intelligence, llm_model, author_relation, urgency_tier
               from challenges where company_id = $1 order by coalesce(posted_at, created_at) desc`,
            [selectedId],
          )
        ).rows;
        const draft_request =
          (
            await c.query(
              "select status, error, model, cost_usd::float, requested_at from draft_requests where company_id = $1 order by requested_at desc limit 1",
              [selectedId],
            )
          ).rows[0] ?? null;
        selected = { ...co, challenges, draft_request } as Company;
      }
    }

    return {
      counts,
      rows,
      options: { verticals: opt?.verticals ?? [], countries: opt?.countries ?? [], sizes: opt?.sizes ?? [] },
      selected,
    };
  });
}
