// Daily alerts (migration 0023, Q65): what the check reads, and what it found.
import { type Alert, type AlertInput, DRIFT_METRICS, type DriftMetric } from "@bs/core";
import type { Db } from "./pool.ts";

export async function alertInputs(db: Db, rotationEnabled: boolean): Promise<AlertInput> {
  const r = (
    await db.query<{ apify_usd: number | null; apify_cap: number | null; ai_usd: number | null; ai_cap: number | null; cards: number; runs: number }>(
      `select (select total_usd from spend_counters where key like 'apify:%' order by key desc limit 1)::float apify_usd,
              (select cap_usd from spend_counters where key like 'apify:%' order by key desc limit 1)::float apify_cap,
              (select total_usd from spend_counters where key = 'month:' || to_char(now(), 'YYYY-MM'))::float ai_usd,
              (select cap_usd from spend_counters where key = 'month:' || to_char(now(), 'YYYY-MM'))::float ai_cap,
              (select count(*) from challenges where created_at > now() - interval '24 hours' and source_type in ('job_post', 'linkedin_post'))::int cards,
              (select count(*) from ingestion_runs where started_at > now() - interval '24 hours')::int runs`,
    )
  ).rows[0]!;
  const failedRuns = (
    await db.query<{ source: string; n: number }>(
      "select job_type source, count(*)::int n from ingestion_runs where status = 'failed' and started_at > now() - interval '24 hours' group by 1 order by 2 desc",
    )
  ).rows;
  // pg-boss puts a job that ran out of retries on the dead-letter queue with its own queue's name.
  const deadJobs = (
    await db.query<{ queue: string; n: number }>(
      `select coalesce(data ->> 'queue', 'unknown') queue, count(*)::int n from pgboss.job
        where name = 'dead-letter' and created_on > now() - interval '24 hours' group by 1 order by 2 desc`,
    )
  ).rows;
  const worse = (
    await db.query<{ metric: DriftMetric }>("select metric from drift_checks where day = (select max(day) from drift_checks) and worse")
  ).rows.map((x) => DRIFT_METRICS[x.metric]?.label ?? x.metric);
  return {
    apify: r.apify_usd !== null && r.apify_cap !== null ? { spent: r.apify_usd, cap: r.apify_cap } : null,
    ai: r.ai_usd !== null && r.ai_cap !== null ? { spent: r.ai_usd, cap: r.ai_cap } : null,
    failedRuns,
    deadJobs,
    cards24h: r.cards,
    runs24h: r.runs,
    rotationEnabled,
    driftWorse: worse,
  };
}

// One row per kind per day; a re-run the same day replaces the message.
export async function saveAlerts(db: Db, day: string, alerts: Alert[], emailed: boolean): Promise<void> {
  for (const a of alerts)
    await db.query(
      `insert into alerts (day, kind, message, emailed) values ($1, $2, $3, $4)
       on conflict (day, kind) do update set message = $3, emailed = alerts.emailed or $4`,
      [day, a.kind, a.message, emailed],
    );
}
