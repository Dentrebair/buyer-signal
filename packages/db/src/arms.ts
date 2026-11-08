// Search arms for the bandit (PRD §4.1c, migration 0011): seeding, linking runs, retiring, and
// the history the planner and the Sources page read.
import type pg from "pg";
import { type Arm, type ArmRun, type ArmSpec, LOW_CARD_VALUE, RETIRE_AFTER_RUNS } from "@bs/core";
import type { Db } from "./pool.ts";

// Idempotent: arms the code knows are added once; existing rows keep their status. A known search
// that a typed run reached first (source 'manual') becomes a seed search.
// One statement for all of them (about 1,050 rows; one round trip each would take minutes).
export async function seedSearchArms(db: Db, specs: ArmSpec[]): Promise<number> {
  const r = await db.query(
    `insert into search_arms (kind, vertical, country, term, grp)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
     on conflict (kind, coalesce(vertical, ''), country, lower(term))
     do update set source = 'seed' where search_arms.source = 'manual'`,
    [specs.map((s) => s.kind), specs.map((s) => s.vertical), specs.map((s) => s.country), specs.map((s) => s.term), specs.map((s) => s.group)],
  );
  return r.rowCount ?? 0;
}

// Links a run to the arms it searched, creating an arm for a search typed by hand.
export async function linkRunArms(c: pg.PoolClient | Db, runId: string, specs: ArmSpec[], source: "seed" | "manual" = "manual"): Promise<void> {
  for (const s of specs) {
    const arm = (
      await c.query<{ id: string }>(
        `insert into search_arms (kind, vertical, country, term, grp, source) values ($1, $2, $3, $4, $5, $6)
         on conflict (kind, coalesce(vertical, ''), country, lower(term)) do update set term = search_arms.term
         returning id`,
        [s.kind, s.vertical, s.country, s.term, s.group, source],
      )
    ).rows[0]!;
    await c.query("insert into run_arms (run_id, arm_id) values ($1, $2) on conflict do nothing", [runId, arm.id]);
  }
}

// Runs from before the bandit, or before LinkedIn post search linked its runs: linked from what
// the run row recorded (its title or topics). A LinkedIn post search's topics have no market.
export async function backfillRunArms(db: Db, groupOf: (kind: "job" | "social", term: string) => ArmSpec["group"]): Promise<number> {
  const runs = (
    await db.query<{ id: string; job_type: string; vertical: string | null; country: string; query_title: string }>(
      `select r.id, r.job_type, r.vertical, case when r.job_type = 'li_posts' then 'all' else r.country end country, r.query_title
         from ingestion_runs r
        where r.query_title is not null and r.job_type in ('indeed', 'linkedin', 'li_posts')
          and (r.country is not null or r.job_type = 'li_posts')
          and not exists (select 1 from run_arms ra where ra.run_id = r.id)`,
    )
  ).rows;
  for (const r of runs) {
    const kind = r.job_type === "indeed" ? "job" : "social";
    const terms = kind === "job" ? [r.query_title] : r.query_title.split(", ").filter(Boolean);
    await linkRunArms(db, r.id, terms.map((term) => ({ kind, vertical: r.vertical, country: r.country, term, group: groupOf(kind, term) })));
  }
  return runs.length;
}

// Retires an active arm with RETIRE_AFTER_RUNS runs since its last revive and no card from them.
export async function retireDeadArms(db: Db): Promise<number> {
  const r = await db.query(
    `update search_arms a set status = 'retired', retired_at = now()
      where a.status = 'active' and (
        select count(*) from run_arms ra join ingestion_runs r on r.id = ra.run_id
         where ra.arm_id = a.id and r.status = 'done' and (a.revived_at is null or r.started_at >= a.revived_at)
      ) >= $1
      and not exists (
        select 1 from run_arms ra join ingestion_runs r on r.id = ra.run_id
         where ra.arm_id = a.id and (a.revived_at is null or r.started_at >= a.revived_at) and r.llm_persisted_count > 0
      )`,
    [RETIRE_AFTER_RUNS],
  );
  return r.rowCount ?? 0;
}

export interface ArmRow extends Arm {
  source: string;
}

// Every arm plus one ArmRun per (run, arm). A run's cost splits evenly across its arms. Its cards
// go to the topic their evidence names (else evenly); a card rejected as not real pain or the
// wrong company is junk. Runs from before cards recorded their run use the run's card count.
export async function armHistory(db: Db): Promise<{ arms: ArmRow[]; runs: ArmRun[] }> {
  const arms = (
    await db.query<{ id: string; kind: "job" | "social"; vertical: string | null; country: string; term: string; grp: Arm["group"]; status: string; revived_at: Date | null; source: string }>(
      "select id, kind, vertical, country, term, grp, status, revived_at, source from search_arms",
    )
  ).rows.map((a) => ({ id: a.id, kind: a.kind, vertical: a.vertical, country: a.country, term: a.term, group: a.grp, retired: a.status === "retired", revivedAt: a.revived_at, source: a.source }));
  const runRows = (
    await db.query<{ id: string; started_at: Date; persisted: number; cost: number; arm_ids: string[] }>(
      `select r.id, r.started_at, r.llm_persisted_count persisted,
              coalesce((select sum(e.cost_usd) from spend_events e where e.run_id = r.id and e.provider = 'apify'), r.estimated_cost_usd)::float cost,
              array_agg(ra.arm_id) arm_ids
         from ingestion_runs r join run_arms ra on ra.run_id = r.id
        where r.status in ('done', 'fetching')
        group by r.id`,
    )
  ).rows;
  const cards = (
    await db.query<{ run_id: string; evidence: string; junk: boolean; low: boolean }>(
      `select ch.run_id, ch.evidence_snippet evidence, coalesce(ch.urgency_tier, 'low') = 'low' low,
              (c.status = 'rejected' and c.rejection_reason in ('not_real_pain', 'wrong_company')) junk
         from challenges ch join companies c on c.id = ch.company_id where ch.run_id is not null`,
    )
  ).rows;
  const byRun = new Map<string, { evidence: string; junk: boolean; low: boolean }[]>();
  for (const c of cards) byRun.set(c.run_id, [...(byRun.get(c.run_id) ?? []), c]);
  const termOf = new Map(arms.map((a) => [a.id, a.term.toLowerCase()]));

  const runs: ArmRun[] = [];
  for (const r of runRows) {
    const ids = r.arm_ids;
    const credit = new Map(ids.map((id) => [id, { cards: 0, junk: 0, value: 0 }]));
    const own = byRun.get(r.id);
    if (own) {
      for (const c of own) {
        const text = c.evidence.toLowerCase();
        const named = ids.filter((id) => text.includes(termOf.get(id)!));
        const to = named.length ? named : ids;
        for (const id of to) {
          const k = credit.get(id)!;
          k.cards += 1 / to.length;
          if (c.junk) k.junk += 1 / to.length;
          else k.value += (c.low ? LOW_CARD_VALUE : 1) / to.length;
        }
      }
    } else if (r.persisted > 0)
      for (const id of ids) {
        // Older runs' cards have no run link and no known tier: counted as Low, like almost all of them.
        credit.get(id)!.cards += r.persisted / ids.length;
        credit.get(id)!.value += (LOW_CARD_VALUE * r.persisted) / ids.length;
      }
    for (const id of ids) runs.push({ armId: id, at: r.started_at, cost: r.cost / ids.length, ...credit.get(id)! });
  }
  return { arms, runs };
}
