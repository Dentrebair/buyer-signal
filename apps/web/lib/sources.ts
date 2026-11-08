// /radar Sources page (PRD §10.3): one row per data source with its latest activity, plus the
// next rotation slot as the default for a manual job-post run. LinkedIn post search has its own
// page (lib/linkedin.ts).
import { type ArmStatus, armStats, armStatus, planDay, priorMean, seededRng } from "@bs/core";
import { armHistory } from "@bs/db";
import { asOperator } from "./operator.ts";

export interface BoardRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  vertical: string | null;
  country: string | null;
  query_title: string | null;
  status: string;
  raw: number;
  passed: number; // sent to extraction (became or joined a card, or no company name)
  cards: number;
  cost_usd: number;
}

// One search the bandit can run (§4.1c), with what it has earned so far.
export interface SearchRow {
  id: string;
  kind: "job" | "social";
  vertical: string | null;
  country: string;
  term: string;
  group: "high" | "medium" | "low";
  source: string;
  status: ArmStatus;
  runs: number;
  cards: number;
  junk: number;
  cost: number;
  perDollar: number; // observed: cards (minus junk) per USD; the posterior only orders the list
  posts: SearchPost[];
}

// A post a search found: a card, or a post the AI read and dropped. LinkedIn post search lists
// its pain posts; the retired Google digest its leads and drops until they age out (§4.1d).
// Credited like the bandit's cards: to the topic the post names, else to every topic of its run.
export interface SearchPost {
  id: string;
  kind: "li" | "social" | "job";
  url: string;
  title: string | null; // job posts: the ad's title
  snippet: string;
  symptom: string | null; // the pain, in the AI's words (the Google digest: its reason for a drop)
  outcome: string; // 'card' or why not (li_posts.card_outcome, social_results.outcome)
  author_relation: string | null;
  stance: string | null;
  company_id: string | null;
  company_name: string | null;
}

const POSTS_PER_SEARCH = 20;

export interface NextJob {
  vertical: string | null;
  country: string;
  title: string;
}

export interface Sources {
  jobs: { runs: BoardRun[]; running: number; next: NextJob | null; cycleSpendUsd: number | null; cycleCapUsd: number | null };
  searches: { rows: SearchRow[]; untried: { job: number; social: number } };
  sniff: { pending: number; done: number; unreachable: number; lastAt: string | null };
  search: { pending: number; searchedToday: number; dailyCap: number };
}

const ACTIVE = ["starting", "running", "fetching"];

export function loadSources(): Promise<Sources> {
  return asOperator(async (c) => {
    const runs = (
      await c.query<BoardRun>(
        `select r.id, r.started_at, r.completed_at, r.vertical, r.country, r.query_title, r.status,
                r.raw_items_ingested raw,
                greatest(0, r.raw_items_ingested - r.dropped_dedup_count - r.dropped_stale_count - r.dropped_trie_count - r.dropped_recruiter_count) passed,
                r.llm_persisted_count cards,
                coalesce((select sum(e.cost_usd) from spend_events e where e.run_id = r.id), r.estimated_cost_usd)::float cost_usd
           from ingestion_runs r where r.job_type = 'indeed'
          order by r.started_at desc limit 8`,
      )
    ).rows;
    const running = runs.filter((r) => ACTIVE.includes(r.status)).length;
    // The bandit's view (§4.1c): every arm's stats, and today's top job pick as the form's default.
    const now = new Date();
    const h = await armHistory(c);
    const priors = { job: priorMean("job", h.arms, h.runs, now), social: priorMean("social", h.arms, h.runs, now) };
    const all = h.arms.map((a) => ({ a, s: armStats(a, h.runs, priors[a.kind], now) }));
    const tried = all.filter((x) => x.s.runs >= 2).map((x) => x.s.mean).sort((p, q) => p - q);
    const median = tried.length ? tried[Math.floor(tried.length / 2)]! : Infinity;
    const searchRows: SearchRow[] = all
      // Searches that have run: one the bandit retired has its 5 runs; the Google digest's topics
      // that never ran (retired with it, §4.1d) stay out.
      .filter((x) => x.s.runs > 0)
      .map(({ a, s }) => ({ id: a.id, kind: a.kind, vertical: a.vertical, country: a.country, term: a.term, group: a.group, source: a.source,
        status: armStatus(a, s, median), runs: s.runs, cards: Math.round(s.cards * 10) / 10, junk: Math.round(s.junk * 10) / 10, cost: s.cost,
        perDollar: s.cost > 0 ? Math.max(0, s.cards - s.junk) / s.cost : 0, posts: [] as SearchPost[], rank: s.mean }))
      .sort((p, q) => (p.status === "retired" ? 1 : 0) - (q.status === "retired" ? 1 : 0) || q.rank - p.rank)
      .map(({ rank: _rank, ...row }) => row);
    // Each search's posts: LinkedIn pain posts, the Google digest's results, job-post cards, by run.
    const found = (
      await c.query<SearchPost & { arm_ids: string[] }>(
        `select p.id, 'li' kind, p.url, null title, left(p.body, 400) snippet, p.pains ->> 0 symptom, coalesce(p.card_outcome, 'before_cards') outcome,
                p.author_relation, p.stance, ch.company_id, co.company_name, array_agg(ra.arm_id) arm_ids
           from li_posts p join run_arms ra on ra.run_id = p.run_id
           left join challenges ch on ch.natural_id = 'post:linkedin:' || p.post_id
           left join companies co on co.id = ch.company_id
          where p.has_pain
          group by p.id, ch.company_id, co.company_name
         union all
         select s.id, 'social', s.url, null title, s.snippet, s.symptom, s.outcome, s.author_relation, s.stance,
                ch.company_id, co.company_name, array_agg(ra.arm_id) arm_ids
           from social_results s join run_arms ra on ra.run_id = s.run_id
           left join challenges ch on ch.source_url = s.url and ch.source_type = 'linkedin_post'
           left join companies co on co.id = ch.company_id
          where s.outcome in ('card', 'stance', 'no_company', 'no_fit', 'too_large', 'ai_error')
          group by s.id, ch.company_id, co.company_name
         union all
         select ch.id, 'job', ch.source_url, split_part(ch.evidence_snippet, E'\n\n', 1), '', ch.structured_intelligence ->> 'verified_symptom', 'card', null, null,
                co.id, co.company_name, array_agg(ra.arm_id)
           from challenges ch join run_arms ra on ra.run_id = ch.run_id join companies co on co.id = ch.company_id
          where ch.source_type = 'job_post'
          group by ch.id, co.id`,
      )
    ).rows;
    const termOf = new Map(h.arms.map((a) => [a.id, a.term.toLowerCase()]));
    const postsOf = new Map<string, SearchPost[]>();
    for (const { arm_ids, ...post } of found) {
      const text = `${post.title ?? ""} ${post.snippet} ${post.symptom ?? ""}`.toLowerCase();
      const named = arm_ids.filter((id) => text.includes(termOf.get(id)!));
      for (const id of named.length ? named : arm_ids) postsOf.set(id, [...(postsOf.get(id) ?? []), post]);
    }
    const lead = (p: SearchPost) => (p.outcome === "card" || p.outcome === "duplicate" ? 0 : 1);
    for (const row of searchRows) row.posts = (postsOf.get(row.id) ?? []).sort((p, q) => lead(p) - lead(q)).slice(0, POSTS_PER_SEARCH);

    const untried = { job: 0, social: 0 };
    for (const x of all) if (x.s.runs === 0 && !x.a.retired) untried[x.a.kind]++;
    const top = planDay(h.arms, h.runs, { job: 1, social: 0, topicsPerSocial: 1 }, seededRng(now.toISOString().slice(0, 10)), now).job[0];
    const next = top ? { vertical: top.vertical, country: top.country, title: top.term } : null;
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
      searches: { rows: searchRows, untried },
      sniff: { ...seeds, lastAt: lastSniff },
      search: { pending: search.pending, searchedToday: search.searched_today, dailyCap: Number(process.env.SEARCH_DAILY_CAP ?? 15) },
    };
  });
}
