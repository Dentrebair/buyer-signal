// Health dashboard (/health, agreed 2026-11-08): what the pipeline did, what it cost, how the AI
// and the company-check agent behaved, over a chosen range, against the range before it.
import { asOperator } from "./operator.ts";

export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];
export const parseRange = (x: unknown): Range => (RANGES.includes(Number(x) as Range) ? (Number(x) as Range) : 30);

export interface Day {
  day: string; // YYYY-MM-DD (UTC)
  cards: number;
  ai_usd: number;
  apify_usd: number;
  li_read: number;
  li_pain: number;
  li_errors: number;
}

export interface Totals {
  cards: number;
  ai_usd: number;
  apify_usd: number;
  li_read: number;
  li_pain: number;
  li_errors: number;
  runs: number;
  failed_runs: number;
}

export interface Observe {
  range: Range;
  days: Day[]; // every day of the range, oldest first, zero-filled
  now: Totals;
  before: Totals; // the same length of time just before the range
  funnel: { read: number; pain: number; kept: number; cards: number };
  notCards: { outcome: string; n: number }[]; // pain posts that did not become cards, by why
  checks: { n: number; found: number; avg_steps: number | null; avg_usd: number | null; stopped: { by: string; n: number }[] };
  sources: { source: string; runs: number; usd: number; cards: number }[]; // usd: settled spend, else the run's reserved estimate
}

export function loadObserve(range: Range): Promise<Observe> {
  return asOperator(async (c) => {
    const p = [range];
    const days = (
      await c.query<Day>(
        `with d as (select generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date as day)
         select to_char(d.day, 'YYYY-MM-DD') as day,
                (select count(*) from challenges ch where ch.created_at::date = d.day and ch.source_type in ('job_post', 'linkedin_post'))::int cards,
                coalesce((select sum(cost_usd) from spend_events e where e.created_at::date = d.day and e.provider = 'openrouter'), 0)::float ai_usd,
                coalesce((select sum(cost_usd) from spend_events e where e.created_at::date = d.day and e.provider = 'apify'), 0)::float apify_usd,
                (select count(*) from li_posts lp where lp.created_at::date = d.day and lp.status = 'read')::int li_read,
                (select count(*) from li_posts lp where lp.created_at::date = d.day and lp.status = 'read' and lp.has_pain)::int li_pain,
                (select count(*) from li_posts lp where lp.created_at::date = d.day and (lp.status = 'ai_error' or lp.card_outcome = 'ai_error'))::int li_errors
           from d order by d.day`,
        p,
      )
    ).rows;
    // Totals for the range ($1 days back) and the one before it, in one pass per table.
    const totals = async (from: number, to: number): Promise<Totals> =>
      (
        await c.query<Totals>(
          `select (select count(*) from challenges where source_type in ('job_post', 'linkedin_post') and created_at >= current_date - $1::int and created_at < current_date - $2::int + 1)::int cards,
                  coalesce((select sum(cost_usd) from spend_events where provider = 'openrouter' and created_at >= current_date - $1::int and created_at < current_date - $2::int + 1), 0)::float ai_usd,
                  coalesce((select sum(cost_usd) from spend_events where provider = 'apify' and created_at >= current_date - $1::int and created_at < current_date - $2::int + 1), 0)::float apify_usd,
                  (select count(*) from li_posts where status = 'read' and created_at >= current_date - $1::int and created_at < current_date - $2::int + 1)::int li_read,
                  (select count(*) from li_posts where status = 'read' and has_pain and created_at >= current_date - $1::int and created_at < current_date - $2::int + 1)::int li_pain,
                  (select count(*) from li_posts where (status = 'ai_error' or card_outcome = 'ai_error') and created_at >= current_date - $1::int and created_at < current_date - $2::int + 1)::int li_errors,
                  (select count(*) from ingestion_runs where started_at >= current_date - $1::int and started_at < current_date - $2::int + 1)::int runs,
                  (select count(*) from ingestion_runs where status = 'failed' and started_at >= current_date - $1::int and started_at < current_date - $2::int + 1)::int failed_runs`,
          [from, to],
        )
      ).rows[0]!;
    // "now" = the last `range` days including today; "before" = the `range` days before those.
    const now = await totals(range - 1, 0);
    const before = await totals(2 * range - 1, range);

    const inRange = "created_at >= current_date - ($1::int - 1)";
    const f = (
      await c.query<{ read: number; pain: number; kept: number; cards: number }>(
        `select count(*) filter (where status = 'read')::int read, count(*) filter (where status = 'read' and has_pain)::int pain,
                count(*) filter (where card_outcome in ('checking', 'card', 'duplicate', 'no_fit', 'too_large', 'ai_error'))::int kept,
                count(*) filter (where card_outcome = 'card')::int cards
           from li_posts where ${inRange}`,
        p,
      )
    ).rows[0]!;
    const notCards = (
      await c.query<{ outcome: string; n: number }>(
        `select card_outcome outcome, count(*)::int n from li_posts
          where ${inRange} and has_pain and card_outcome not in ('card', 'checking') group by 1 order by 2 desc`,
        p,
      )
    ).rows;
    const at = "(company_check ->> 'checkedAt')::timestamptz";
    const ck = (
      await c.query<{ n: number; found: number; avg_steps: number | null; avg_usd: number | null }>(
        `select count(*)::int n, count(*) filter (where company_check ->> 'domain' is not null)::int found,
                avg((company_check ->> 'steps')::float) avg_steps, avg((company_check ->> 'costUsd')::float) avg_usd
           from companies where company_check ? 'checkedAt' and ${at} >= current_date - ($1::int - 1)`,
        p,
      )
    ).rows[0]!;
    const stopped = (
      await c.query<{ by: string; n: number }>(
        `select company_check ->> 'stoppedBy' as "by", count(*)::int n from companies
          where company_check ? 'checkedAt' and ${at} >= current_date - ($1::int - 1) group by 1 order by 2 desc`,
        p,
      )
    ).rows;
    const sources = (
      await c.query<{ source: string; runs: number; usd: number; cards: number }>(
        `select r.job_type source, count(*)::int runs,
                coalesce(sum(coalesce((select sum(e.cost_usd) from spend_events e where e.run_id = r.id), r.estimated_cost_usd)), 0)::float usd,
                sum(r.llm_persisted_count)::int cards
           from ingestion_runs r where r.started_at >= current_date - ($1::int - 1) group by 1 order by 3 desc`,
        p,
      )
    ).rows;
    return { range, days, now, before, funnel: f, notCards, checks: { ...ck, stopped }, sources };
  });
}
