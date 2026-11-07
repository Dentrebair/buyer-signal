// /radar Sources page (PRD §10.3): one row per data source with its latest activity, plus the
// next rotation slot as the default for a manual job-post run.
import { type PlannedSlot, planRotation } from "@bs/core";
import { rotationHistory } from "@bs/db";
import { asOperator } from "./operator.ts";

export interface BoardRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  checking: number; // social posts the AI has still to read
  vertical: string | null;
  country: string | null;
  query_title: string | null;
  status: string;
  raw: number;
  passed: number; // sent to extraction (became or joined a card, or no company name)
  cards: number;
  cost_usd: number;
}

// A Social digest post that became a card (social_results outcome 'card'), with its card's
// automation share. Dropped results stay in the table but are not listed.
export interface SocialLead {
  id: string;
  url: string;
  snippet: string;
  posted_at: string | null;
  stance: string | null;
  symptom: string | null;
  company_id: string | null;
  company_name: string | null;
  automatable_pct: number | null;
  signal_score: number | null;
}

// A post the AI read and dropped; kept 7 days so its judgement can be checked.
export interface SocialDrop {
  id: string;
  url: string;
  snippet: string;
  outcome: string;
  author_relation: string | null;
  stance: string | null;
  symptom: string | null;
}

export interface Sources {
  jobs: { runs: BoardRun[]; running: number; next: PlannedSlot | null; cycleSpendUsd: number | null; cycleCapUsd: number | null };
  social: { runs: BoardRun[]; running: number; shown: BoardRun | null; leads: SocialLead[]; drops: SocialDrop[] };
  sniff: { pending: number; done: number; unreachable: number; lastAt: string | null };
  search: { pending: number; searchedToday: number; dailyCap: number };
}

const ACTIVE = ["starting", "running", "fetching"];

// runId: the social run whose posts are listed (default: the latest).
export function loadSources(runId?: string | null): Promise<Sources> {
  return asOperator(async (c) => {
    const recent = async (jobType: "indeed" | "linkedin") =>
      (
        await c.query<BoardRun>(
        `select r.id, r.started_at, r.completed_at, r.vertical, r.country, r.query_title, r.status,
                r.raw_items_ingested raw,
                greatest(0, r.raw_items_ingested - r.dropped_dedup_count - r.dropped_stale_count - r.dropped_trie_count - r.dropped_recruiter_count) passed,
                r.llm_persisted_count cards,
                (select count(*) from social_results s where s.run_id = r.id and s.outcome = 'checking')::int checking,
                coalesce((select sum(e.cost_usd) from spend_events e where e.run_id = r.id), r.estimated_cost_usd)::float cost_usd
           from ingestion_runs r where r.job_type = $1
          order by r.started_at desc limit 8`,
          [jobType],
        )
      ).rows;
    const runs = await recent("indeed");
    const socialRuns = await recent("linkedin");
    const running = runs.filter((r) => ACTIVE.includes(r.status)).length;
    const shown = socialRuns.find((r) => r.id === runId) ?? socialRuns[0] ?? null;
    const leads = shown
      ? (
          await c.query<SocialLead>(
            `select s.id, s.url, s.snippet, s.posted_at, s.stance, s.symptom, ch.company_id, co.company_name, ch.signal_score,
                    (ch.structured_intelligence ->> 'automatable_task_percentage')::int automatable_pct
               from social_results s
               left join challenges ch on ch.source_url = s.url and ch.source_type = 'linkedin_post'
               left join companies co on co.id = ch.company_id
              where s.run_id = $1 and s.outcome = 'card'
              order by ch.signal_score desc nulls last, s.created_at`,
            [shown.id],
          )
        ).rows
      : [];
    const drops = shown
      ? (
          await c.query<SocialDrop>(
            `select id, url, snippet, outcome, author_relation, stance, symptom from social_results
              where run_id = $1 and outcome in ('stance', 'no_company', 'no_fit', 'too_large') order by created_at`,
            [shown.id],
          )
        ).rows
      : [];
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
      social: { runs: socialRuns, running: socialRuns.filter((r) => ACTIVE.includes(r.status) || r.checking > 0).length, shown, leads, drops },
      sniff: { ...seeds, lastAt: lastSniff },
      search: { pending: search.pending, searchedToday: search.searched_today, dailyCap: Number(process.env.SEARCH_DAILY_CAP ?? 15) },
    };
  });
}
