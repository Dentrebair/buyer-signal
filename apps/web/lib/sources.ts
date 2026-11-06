// /radar Sources page (PRD §10.3): one row per data source with its latest activity, plus the
// next rotation slot as the default for a manual job-post run.
import { type PlannedSlot, planRotation } from "@bs/core";
import { rotationHistory } from "@bs/db";
import { asOperator } from "./operator.ts";

export interface BoardRun {
  id: string;
  started_at: string;
  vertical: string | null;
  country: string | null;
  query_title: string | null;
  status: string;
  raw: number;
  passed: number; // sent to extraction (became or joined a card, or no company name)
  cards: number;
  cost_usd: number;
}

export interface Sources {
  jobs: { runs: BoardRun[]; running: number; next: PlannedSlot | null; cycleSpendUsd: number | null; cycleCapUsd: number | null };
  sniff: { pending: number; done: number; unreachable: number; lastAt: string | null };
  search: { pending: number; searchedToday: number; dailyCap: number };
}

export function loadSources(): Promise<Sources> {
  return asOperator(async (c) => {
    const runs = (
      await c.query<BoardRun>(
        `select r.id, r.started_at, r.vertical, r.country, r.query_title, r.status,
                r.raw_items_ingested raw,
                greatest(0, r.raw_items_ingested - r.dropped_dedup_count - r.dropped_stale_count - r.dropped_trie_count - r.dropped_recruiter_count) passed,
                r.llm_persisted_count + r.persisted_no_website_count cards,
                coalesce((select sum(e.cost_usd) from spend_events e where e.run_id = r.id), r.estimated_cost_usd)::float cost_usd
           from ingestion_runs r where r.job_type = 'indeed'
          order by r.started_at desc limit 8`,
      )
    ).rows;
    const running = runs.filter((r) => ["starting", "running", "fetching"].includes(r.status)).length;
    const next = planRotation(await rotationHistory(c), 1, new Date())[0] ?? null;
    const cycle = (
      await c.query<{ total_usd: string; cap_usd: string }>("select total_usd, cap_usd from spend_counters where key like 'apify:%' order by key desc limit 1")
    ).rows[0];

    const seeds = (
      await c.query<{ pending: number; done: number; unreachable: number }>(
        `select count(*) filter (where status in ('pending', 'processing'))::int pending,
                count(*) filter (where status = 'done')::int done,
                count(*) filter (where status = 'unreachable')::int unreachable
           from seed_urls`,
      )
    ).rows[0]!;
    const lastSniff = (await c.query<{ at: string | null }>("select max(last_sniffed_at) at from companies")).rows[0]?.at ?? null;
    const search = (await c.query<{ pending: number; searched_today: number }>("select * from radar_resolve_stats()")).rows[0]!;

    return {
      jobs: { runs, running, next, cycleSpendUsd: cycle ? Number(cycle.total_usd) : null, cycleCapUsd: cycle ? Number(cycle.cap_usd) : null },
      sniff: { ...seeds, lastAt: lastSniff },
      search: { pending: search.pending, searchedToday: search.searched_today, dailyCap: Number(process.env.SEARCH_DAILY_CAP ?? 15) },
    };
  });
}
