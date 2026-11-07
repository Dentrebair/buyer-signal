// Company + challenge repository (PRD §5.1 steps 7–8). Callers pass a transaction client so the
// challenge insert and the score recompute commit together (§7).
import type pg from "pg";
import {
  type AuthorRelation,
  type ScoredSignal,
  type SizeSource,
  type SizeTier,
  type SourceType,
  type StructuredIntelligence,
  companyScore,
} from "@bs/core";

export interface CompanyUpsert {
  domain: string | null; // null = no website found (card marked "No website")
  nameKey?: string | null; // '<country>:<normalized name>:<city>'; required when domain is null
  companyName: string | null;
  vertical: string | null;
  country: string | null;
  employeeBand: string | null;
  sizeTier: SizeTier;
  sizeSource: SizeSource;
  domainRegisteredAt?: Date | null; // RDAP (§6.7 step 2)
  isSample?: boolean;
}

// Fill gaps on an existing company, never overwrite what an earlier source set.
const FILL_GAPS = `
       company_name  = coalesce(companies.company_name, excluded.company_name),
       vertical      = coalesce(companies.vertical, excluded.vertical),
       country       = coalesce(companies.country, excluded.country),
       employee_band = coalesce(companies.employee_band, excluded.employee_band),
       domain_registered_at = coalesce(companies.domain_registered_at, excluded.domain_registered_at),
       size_tier     = case when companies.size_tier in ('unknown') or companies.size_tier is null
                            then excluded.size_tier else companies.size_tier end,
       size_source   = case when companies.size_tier in ('unknown') or companies.size_tier is null
                            then excluded.size_source else companies.size_source end`;
const COLUMNS = "(domain, name_key, company_name, vertical, country, employee_band, size_tier, size_source, domain_registered_at, is_sample)";

// Returns the company id. With a domain, a no-website card for the same firm (same name key,
// still in the inbox) gets the domain, or is folded into the company that already has it.
export async function upsertCompany(c: pg.PoolClient, x: CompanyUpsert): Promise<string> {
  if (!x.domain && !x.nameKey) throw new Error("upsertCompany: a company needs a domain or a name key");
  const values = (domain: string | null, nameKey: string | null) => [
    domain, nameKey, x.companyName, x.vertical, x.country, x.employeeBand, x.sizeTier, x.sizeSource, x.domainRegisteredAt ?? null, x.isSample ?? false,
  ];
  if (!x.domain) {
    const r = await c.query<{ id: string }>(
      `insert into companies ${COLUMNS} values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (name_key) do update set ${FILL_GAPS} returning id`,
      values(null, x.nameKey!),
    );
    return r.rows[0]!.id;
  }
  if (x.nameKey) {
    await c.query(
      `update companies set domain = $1 where name_key = $2 and domain is null and status = 'new'
         and not exists (select 1 from companies where domain = $1)`,
      [x.domain, x.nameKey],
    );
  }
  const r = await c.query<{ id: string }>(
    `insert into companies ${COLUMNS} values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (domain) do update set ${FILL_GAPS} returning id`,
    values(x.domain, null),
  );
  const id = r.rows[0]!.id;
  if (x.nameKey) {
    const src = (await c.query<{ id: string }>("select id from companies where name_key = $1 and domain is null and status = 'new' for update", [x.nameKey])).rows[0];
    if (src) {
      await c.query("update challenges set company_id = $2 where company_id = $1", [src.id, id]);
      await c.query("delete from companies where id = $1", [src.id]);
    }
    await c.query("update companies set name_key = $2 where id = $1 and name_key is null and not exists (select 1 from companies where name_key = $2)", [id, x.nameKey]);
  }
  return id;
}

// Registration date already stored for this domain, so RDAP is asked once per domain.
export async function storedRegisteredAt(db: pg.Pool | pg.PoolClient, domain: string): Promise<Date | null> {
  const r = await db.query<{ d: Date | null }>("select domain_registered_at as d from companies where domain = $1", [domain]);
  return r.rows[0]?.d ?? null;
}

export interface ChallengeInsert {
  companyId: string;
  sourceType: SourceType;
  naturalId: string;
  sourceUrl: string | null;
  E: number;
  I: number;
  B: number;
  signalScore: number;
  department: string;
  postedAt: Date | null;
  evidenceSnippet: string;
  structuredIntelligence: StructuredIntelligence | null;
  llmModel: string | null;
  authorRelation?: AuthorRelation | null;
  urgencyTier?: "high" | "medium" | "low" | null;
}

// Safe to run twice: natural_id is unique (§5.3a). Returns false when it already existed.
export async function insertChallenge(c: pg.PoolClient, x: ChallengeInsert): Promise<boolean> {
  const r = await c.query(
    `insert into challenges (company_id, source_type, natural_id, source_url, evidence_confidence, buying_intent,
       blast_radius, signal_score, department, posted_at, evidence_snippet, structured_intelligence, llm_model, author_relation, urgency_tier)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     on conflict (natural_id) do nothing`,
    [
      x.companyId,
      x.sourceType,
      x.naturalId,
      x.sourceUrl,
      x.E,
      x.I,
      x.B,
      x.signalScore,
      x.department,
      x.postedAt,
      x.evidenceSnippet.slice(0, 2000),
      x.structuredIntelligence,
      x.llmModel,
      x.authorRelation ?? null,
      x.urgencyTier ?? null,
    ],
  );
  return r.rowCount === 1;
}

// Recomputes from every challenge of the company (§7). Locks the row so concurrent inserts
// for the same company serialise.
export async function recomputeCompanyScore(c: pg.PoolClient, companyId: string): Promise<number> {
  await c.query("select 1 from companies where id = $1 for update", [companyId]);
  const rows = (
    await c.query<{ id: string; source_type: SourceType; evidence_confidence: number; buying_intent: number; blast_radius: number; signal_score: number }>(
      "select id, source_type, evidence_confidence, buying_intent, blast_radius, signal_score from challenges where company_id = $1",
      [companyId],
    )
  ).rows;
  const signals: ScoredSignal[] = rows.map((r) => ({
    id: r.id,
    sourceType: r.source_type,
    E: r.evidence_confidence,
    I: r.buying_intent,
    B: r.blast_radius,
    signalScore: r.signal_score,
  }));
  const { score, breakdown } = companyScore(signals);
  await c.query(
    `update companies set priority_score = $2, score_breakdown = $3,
       draft_stale = (outreach_drafts is not null) where id = $1`,
    [companyId, score, breakdown],
  );
  return score;
}

// New domain → website sniff later (§5.1 step 7, §5.4). Safe to run twice.
export async function insertSeedUrl(c: pg.PoolClient, domain: string, companyId: string, origin: "job_post" | "linkedin_post" | "social_post" | "inbound") {
  await c.query("insert into seed_urls (domain, company_id, origin) values ($1, $2, $3) on conflict (domain) do nothing", [domain, companyId, origin]);
}
