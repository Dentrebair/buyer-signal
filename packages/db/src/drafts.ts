// Email drafts (migration 0024, §9): what the draft prompt sees, and where the result goes.
import type pg from "pg";
import type { DraftCompany, DraftEvidence, OutreachDrafts, StructuredIntelligence } from "@bs/core";
import type { Db } from "./pool.ts";

export async function draftRequest(db: Db, id: string): Promise<{ id: string; companyId: string; status: string } | null> {
  const r = (await db.query<{ id: string; companyId: string; status: string }>('select id, company_id "companyId", status from draft_requests where id = $1', [id])).rows[0];
  return r ?? null;
}

// The company and its evidence, strongest first. An employee's post is passed as a pattern only:
// no URL, no words of theirs (§9, Q61).
export async function draftInput(db: Db, companyId: string): Promise<DraftCompany | null> {
  const c = (
    await db.query<{ company_name: string | null; domain: string | null; vertical: string | null; country: string | null; founder_name: string | null; tech_stack: (string | { name: string })[] }>(
      "select company_name, domain, vertical, country, founder_name, tech_stack from companies where id = $1",
      [companyId],
    )
  ).rows[0];
  if (!c) return null;
  const rows = (
    await db.query<{ source_type: string; author_relation: string | null; evidence_snippet: string; evidence_confidence: number; si: StructuredIntelligence | null }>(
      `select source_type, author_relation, evidence_snippet, evidence_confidence, structured_intelligence si
         from challenges where company_id = $1 and source_type <> 'inbound' order by signal_score desc, created_at desc limit 8`,
      [companyId],
    )
  ).rows;
  const evidence: DraftEvidence[] = rows.map((r) => {
    const [first = "", ...rest] = r.evidence_snippet.split("\n\n");
    const base = { confidence: r.evidence_confidence, hours: r.si?.blast_radius?.estimated_hours_wasted_weekly ?? null, replacement: r.si?.proposed_ai_replacement ?? null };
    if (r.source_type === "job_post") return { ...base, kind: "job_post", title: first, symptom: r.si?.verified_symptom ?? first, quote: rest.join("\n\n").slice(0, 600) || null };
    if (r.source_type === "dom_sniff" || r.source_type === "tech_stack") return { ...base, kind: "website", title: null, symptom: first, quote: null, hours: null };
    if (r.author_relation === "employee" || !r.author_relation) return { ...base, kind: "employee_pattern", title: null, symptom: r.si?.verified_symptom ?? "manual desk work", quote: null };
    return { ...base, kind: "own_post", title: null, symptom: r.si?.verified_symptom ?? first, quote: r.evidence_snippet.slice(0, 600) };
  });
  const best = rows.find((r) => r.si?.product_layer)?.si?.product_layer ?? null;
  return {
    name: c.company_name ?? c.domain ?? "the company",
    website: c.domain,
    vertical: c.vertical,
    country: c.country,
    founderName: c.founder_name,
    productLayer: best,
    techStack: c.tech_stack.map((t) => (typeof t === "string" ? t : t.name)),
    websiteIssues: evidence.filter((e) => e.kind === "website").map((e) => e.symptom),
    evidence,
  };
}

// The drafts replace any earlier ones, and are fresh again until new evidence arrives.
export async function saveDrafts(c: pg.PoolClient, x: { requestId: string; companyId: string; drafts: OutreachDrafts; model: string; costUsd: number }): Promise<void> {
  await c.query("update companies set outreach_drafts = $2, draft_generated_at = now(), draft_stale = false where id = $1", [x.companyId, x.drafts]);
  await c.query("update draft_requests set status = 'done', model = $2, cost_usd = $3, finished_at = now() where id = $1", [x.requestId, x.model, x.costUsd]);
}

export async function failDraft(db: Db, requestId: string, error: string): Promise<void> {
  await db.query("update draft_requests set status = 'error', error = $2, finished_at = now() where id = $1 and status = 'queued'", [requestId, error.slice(0, 300)]);
}

// Safety net (poll-runs): a request still writing after 10 minutes failed somewhere.
export async function expireDraftRequests(db: Db): Promise<number> {
  return (
    (await db.query("update draft_requests set status = 'error', error = 'Timed out', finished_at = now() where status = 'queued' and requested_at < now() - interval '10 minutes'"))
      .rowCount ?? 0
  );
}
