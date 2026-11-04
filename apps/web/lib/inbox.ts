// Inbox queries (PRD §10.1). Queues and filters come from the URL so a view can be bookmarked.
import type { ScoreBreakdown, SizeTier, SourceFamily, SourceType, StructuredIntelligence } from "@bs/core";
import { asOperator } from "./operator.ts";

export const QUEUES = ["triage", "nurture", "sent", "rejected"] as const;
export type Queue = (typeof QUEUES)[number];

export interface View {
  queue: Queue;
  sort: "score" | "newest";
  vertical: string | null;
  country: string | null;
  size: SizeTier | null;
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
  if (x.id) p.set("id", x.id);
  return `/dashboard?${p}`;
}

// §10.1: Triage > 70, Nurture 50–70, hidden < 50 (never listed here).
const QUEUE_SQL: Record<Queue, string> = {
  triage: "c.status = 'new' and c.priority_score > 70",
  nurture: "c.status = 'new' and c.priority_score between 50 and 70",
  sent: "c.status = 'actioned'",
  rejected: "c.status = 'rejected'",
};

export interface Row {
  id: string;
  domain: string;
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
}

export interface Company extends Row {
  status: "new" | "actioned" | "rejected";
  rejection_reason: string | null;
  employee_band: string | null;
  size_source: string | null;
  tech_stack: string[];
  actioned_at: string | null;
  challenges: Challenge[];
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
                (best.si -> 'blast_radius' ->> 'estimated_hours_wasted_weekly')::int as hours
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
          `select c.*, coalesce((select array_agg(distinct ch.source_family) from challenges ch where ch.company_id = c.id), '{}') as families
             from companies c where c.id = $1`,
          [selectedId],
        )
      ).rows[0];
      if (co) {
        const challenges = (
          await c.query<Challenge>(
            `select id, source_type, source_url, signal_score, evidence_confidence, buying_intent, blast_radius, department,
                    posted_at, created_at, evidence_snippet, structured_intelligence, llm_model, author_relation
               from challenges where company_id = $1 order by coalesce(posted_at, created_at) desc`,
            [selectedId],
          )
        ).rows;
        selected = { ...co, challenges } as Company;
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
