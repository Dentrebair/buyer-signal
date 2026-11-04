// Ingestion bookkeeping (PRD §5.1, §5.3, Q63): ingestion_runs, seen_items dedup, domain_cache.
import type pg from "pg";
import { apifyCycleKey } from "@bs/core";
import type { Db } from "./pool.ts";
import { reserveSpend } from "./spend.ts";

export type DropCounter =
  | "raw_items_ingested"
  | "dropped_stale_count"
  | "dropped_dedup_count"
  | "dropped_trie_count"
  | "dropped_recruiter_count"
  | "dropped_unresolved_count"
  | "dropped_size_count"
  | "dropped_stance_count"
  | "dropped_no_fit_count"
  | "llm_persisted_count";

// Written before the paid run starts (status 'starting'); null = this job key already has a row.
export async function createRun(
  db: Db,
  x: { jobKey: string; jobType: string; vertical: string | null; country: string | null; estimatedCostUsd: number },
): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    `insert into ingestion_runs (job_key, job_type, vertical, country, estimated_cost_usd, status)
     values ($1, $2, $3, $4, $5, 'starting') on conflict (job_key) do nothing returning id`,
    [x.jobKey, x.jobType, x.vertical, x.country, x.estimatedCostUsd],
  );
  return r.rows[0]?.id ?? null;
}

export async function getRunByJobKey(db: Db, jobKey: string) {
  const r = await db.query<{ id: string; apify_run_id: string | null; status: string }>(
    "select id, apify_run_id, status from ingestion_runs where job_key = $1",
    [jobKey],
  );
  return r.rows[0] ?? null;
}

export async function recordApifyRun(db: Db, id: string, apifyRunId: string): Promise<void> {
  await db.query("update ingestion_runs set apify_run_id = $2, status = 'running' where id = $1", [id, apifyRunId]);
}

export async function getRunByApifyId(db: Db, apifyRunId: string) {
  const r = await db.query<{ id: string; status: string; country: string | null; vertical: string | null; estimated_cost_usd: string }>(
    "select id, status, country, vertical, estimated_cost_usd from ingestion_runs where apify_run_id = $1",
    [apifyRunId],
  );
  return r.rows[0] ?? null;
}

export async function setRunStatus(db: Db, id: string, status: "starting" | "running" | "fetching" | "done" | "failed"): Promise<void> {
  await db.query(
    `update ingestion_runs set status = $2, completed_at = case when $2 in ('done','failed') then now() else completed_at end where id = $1`,
    [id, status],
  );
}

// Runs started but not yet seen finished — the poll job's work list (webhook safety net).
export async function unfinishedRuns(db: Db, olderThanSeconds: number) {
  const r = await db.query<{ id: string; apify_run_id: string }>(
    `select id, apify_run_id from ingestion_runs
      where status = 'running' and apify_run_id is not null and started_at < now() - make_interval(secs => $1)
      order by started_at limit 20`,
    [olderThanSeconds],
  );
  return r.rows;
}

const COUNTERS = new Set<DropCounter>([
  "raw_items_ingested", "dropped_stale_count", "dropped_dedup_count", "dropped_trie_count", "dropped_recruiter_count",
  "dropped_unresolved_count", "dropped_size_count", "dropped_stance_count", "dropped_no_fit_count", "llm_persisted_count",
]);

export async function bumpCounters(db: Db, runId: string, counts: Partial<Record<DropCounter, number>>): Promise<void> {
  const entries = Object.entries(counts).filter(([k, n]) => COUNTERS.has(k as DropCounter) && n);
  if (!entries.length) return;
  // Column names come from the allow-list above, never from input.
  const sets = entries.map(([k], i) => `${k} = ${k} + $${i + 2}`).join(", ");
  await db.query(`update ingestion_runs set ${sets} where id = $1`, [runId, ...entries.map(([, n]) => n)]);
}

// true = first time seen (§5.1 step 2). Safe to call twice.
export async function markSeen(db: Db, naturalId: string, ttlDays = 30): Promise<boolean> {
  const r = await db.query(
    "insert into seen_items (natural_id, expires_at) values ($1, now() + make_interval(days => $2)) on conflict do nothing",
    [naturalId, ttlDays],
  );
  return r.rowCount === 1;
}

// undefined = no cache entry; null = cached miss.
export async function cachedDomain(db: Db, key: string): Promise<string | null | undefined> {
  const r = await db.query<{ domain: string | null }>("select domain from domain_cache where key = $1 and expires_at > now()", [key]);
  return r.rows.length ? r.rows[0]!.domain : undefined;
}

export async function cacheDomain(db: Db, key: string, domain: string | null): Promise<void> {
  // Hits 30 days, misses 7 days (§5.1 step 5).
  await db.query(
    `insert into domain_cache (key, domain, expires_at) values ($1, $2, now() + make_interval(days => $3))
     on conflict (key) do update set domain = excluded.domain, expires_at = excluded.expires_at`,
    [key, domain, domain ? 30 : 7],
  );
}

// Apify cycle gate (Q58): reserve the run's worst case against apify:{cycle_start}.
export function reserveApifyRun(db: Db, cycleStart: Date, worstCaseUsd: number, capUsd: number): Promise<boolean> {
  return reserveSpend(db, apifyCycleKey(cycleStart), worstCaseUsd, capUsd);
}

// Daily reconcile: Apify's own number replaces the counter (§5.3).
export async function reconcileApifyCycle(db: Db, cycleStart: Date, usageUsd: number, capUsd: number): Promise<void> {
  await db.query(
    `insert into spend_counters (key, total_usd, cap_usd) values ($1, $2, $3)
     on conflict (key) do update set total_usd = excluded.total_usd, cap_usd = excluded.cap_usd, updated_at = now()`,
    [apifyCycleKey(cycleStart), usageUsd, capUsd],
  );
}

// Replaces a run's reservation with its exact cost once it finishes.
export async function settleApifyRun(
  c: pg.PoolClient,
  x: { cycleStart: Date; reservedUsd: number; actualUsd: number; runId: string; ref: string },
): Promise<void> {
  await c.query("update spend_counters set total_usd = greatest(0, total_usd - $2 + $3), updated_at = now() where key = $1", [
    apifyCycleKey(x.cycleStart),
    x.reservedUsd,
    x.actualUsd,
  ]);
  await c.query("insert into spend_events (provider, units, cost_usd, run_id, ref) values ('apify', 1, $1, $2, $3)", [
    x.actualUsd,
    x.runId,
    x.ref,
  ]);
}

// First reservation of a cycle starts from Apify's real usage, not zero.
export async function seedApifyCycle(db: Db, cycleStart: Date, usageUsd: number, capUsd: number): Promise<void> {
  await db.query("insert into spend_counters (key, total_usd, cap_usd) values ($1, $2, $3) on conflict (key) do nothing", [
    apifyCycleKey(cycleStart),
    usageUsd,
    capUsd,
  ]);
}

// Moves a run from 'running' to `to` exactly once; false if another job got there first.
export async function claimRun(db: Db, id: string, to: "fetching" | "failed"): Promise<boolean> {
  const r = await db.query(
    "update ingestion_runs set status = $2, completed_at = case when $2 = 'failed' then now() else completed_at end where id = $1 and status = 'running'",
    [id, to],
  );
  return r.rowCount === 1;
}
