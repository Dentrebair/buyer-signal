// Worker jobs against the real database with fake Apify + LLM (Q66: fakes for providers).
// Skipped when DATABASE_URL is absent (CI has no database). Every row it writes is removed.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { type LlmClient, type StructuredIntelligence, Q, apifyCycleKey, auditSite, parseHtml } from "@bs/core";
import { approvedAtoms, claimSeeds, createPool, labelLiPost, recordDropSample, withTransaction } from "@bs/db";
import type { ApifyRun, SniffResult } from "@bs/integrations";
import {
  type Deps,
  type Send,
  auditDropped,
  dailyAlertsJob,
  cardLiComment,
  cardLiPost,
  driftCheck,
  extractLlm,
  fetchDataset,
  fetchLiRun,
  ingestRotation,
  readLiPost,
  startLiRun,
  syncSearchArms,
  onApifyRunEvent,
  resolveBatch,
  sniffDomain,
  startBoardRun,
} from "../src/jobs.ts";

const items = JSON.parse(readFileSync(new URL("../../../packages/integrations/test/fixtures/indeed-items.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-03T12:00:00Z");
const CYCLE = new Date("2000-01-16T00:00:00Z"); // test-only cycle key, never a real one
const ROTATION_DAY = new Date("2000-01-02T02:00:00Z"); // test-only rotation day
// LinkedIn post ids carry their time (id >> 22 = Unix ms).
const act = (d: Date) => (BigInt(d.getTime()) << 22n).toString();
const RUN_ID = "testRunFixture01";
const DOMAIN = "acme-freight.example";
const R_DOMAIN = "resolve-test.example"; // resolve-path test company
const R_PREFIX = "job:indeed:resolvetest";
const TWIN_DOMAIN = "resolve-twin.example";
const AGE_DOMAIN = "age-test.example"; // domain-age test company
const AGE_PREFIX = "job:indeed:agetest";
const SNIFF_DOMAIN = "sniff-test.example";

const si: StructuredIntelligence = {
  department: "Finance",
  verified_symptom: "Hiring an AP clerk to key freight invoices into QuickBooks by hand",
  inferred_tech_stack: ["QuickBooks"],
  automatable_task_percentage: 70,
  proposed_ai_replacement: "Invoice capture into QuickBooks",
  blast_radius: { frequency: "Daily", urgency_level: "Blocking", founder_dependency_flag: false, estimated_hours_wasted_weekly: 20 },
  automation_fit: "high",
  product_layer: "company_os",
  known_large_brand: false,
  author_relation: null,
  stance: null,
  solved_how: null,
};

function fakes(
  pool: pg.Pool,
  over: { usageUsd?: number; capUsd?: number; searchCap?: number; resolveTo?: { domain: string | null; cited: string[] }; pages?: Record<string, string>;
    ages?: Record<string, Date | null | "error">;
    sniffs?: Record<string, SniffResult>;
    lagging?: boolean; rotation?: boolean; now?: Date;
    dataset?: object[]; liCard?: Record<string, unknown>; liRead?: (user: string) => object; leak?: (user: string) => object } = {},
) {
  const sent: { queue: string; data: any; opts?: object }[] = [];
  const archived: { source: string; day: string; runId: string; part: string; items: unknown[] }[] = [];
  const started: object[] = [];
  const run: ApifyRun = {
    id: RUN_ID,
    status: "SUCCEEDED",
    defaultDatasetId: "testDataset01",
    // `lagging`: the run reports done before Apify has counted its items (seen live, 2026-11-04).
    chargedEventCounts: over.lagging ? { "apify-actor-start": 1 } : { "apify-default-dataset-item": 2, "apify-actor-start": 1 },
    startedAt: NOW.toISOString(),
  };
  const llm: LlmClient = {
    worstCaseUsd: async () => 0.001,
    json: async (task, req) =>
      task === "resolve"
        ? // The company-check agent (§5.1a), finishing on its first step.
          { data: req.parse({ notes: "fake", action: "finish", query: null, url: null, domain: over.resolveTo?.domain ?? null, size_band: "11-50", size_evidence_url: null, vertical_match: "yes", place_match: "yes", summary: "A test company." }) as any, model: "fake/model", costUsd: 0.002, citations: over.resolveTo?.cited ?? [] }
        : req.schemaName === "linkedin_read"
          ? { data: req.parse(over.liRead!(req.user)) as any, model: "fake/model", costUsd: 0.0004 }
        : req.schemaName === "leak_check"
          ? { data: req.parse(over.leak!(req.user)) as any, model: "fake/model", costUsd: 0.0003 }
        : req.schemaName === "linkedin_card"
          ? { data: req.parse({ ...si, vertical: "logistics", ...over.liCard }) as any, model: "fake/model", costUsd: 0 }
          : req.schemaName === "seed_extraction" // a run with no vertical asks for it
            ? { data: req.parse({ ...si, vertical: "construction" }) as any, model: "fake/model", costUsd: 0 }
            : { data: req.parse(si) as any, model: "fake/model", costUsd: 0 },
  };
  const send: Send = async (queue, data, opts) => void sent.push({ queue, data, ...(opts ? { opts } : {}) });
  const rdapCalls: string[] = [];
  const deps: Deps = {
    pool,
    apify: {
      usage: async () => ({ cycleStart: CYCLE, cycleEnd: CYCLE, usageUsd: over.usageUsd ?? 0, limitUsd: 5 }),
      startRun: async (_a, input) => (started.push(input), { ...run, status: "READY" }),
      getRun: async () => run,
      datasetItems: async (_id, offset) => (offset === 0 ? (over.dataset ?? items) : []) as any,
      datasetItemCount: async () => (over.dataset ?? items).length,
    },
    llm,
    fetchPage: async (url) => (over.pages?.[url] ? { url, status: 200, html: over.pages[url]!, headers: {} } : null),
    rdap: {
      registeredAt: async (domain) => {
        rdapCalls.push(domain);
        const a = over.ages?.[domain] ?? null;
        if (a === "error") throw new Error("rdap 429");
        return a;
      },
    },
    sniff: async (x) => over.sniffs?.[x.domain] ?? { reachable: false, reason: "no fake" },
    archive: { put: async (x) => void archived.push(x), purge: async () => 0 },
    mailer: null,
    send,
    settings: {
      apifyCycleCapUsd: over.capUsd ?? 4.5,
      searchDailyCap: over.searchCap ?? 15,
      rotationEnabled: over.rotation ?? false,
      boardSlotsPerDay: 3,
      boardPostsPerSlot: 35,
      socialSlotsPerDay: 1,
      liPostsPerTopic: 5,
      liCommentsPerPost: 5,
      healthUrl: "http://localhost:3000/health",
    },
    now: () => over.now ?? NOW,
    log: () => {},
  };
  return { deps, sent, started, rdapCalls, archived };
}

async function cleanup(pool: pg.Pool) {
  await pool.query("delete from companies where domain = $1", [DOMAIN]);
  await pool.query("delete from seed_urls where domain = $1", [DOMAIN]);
  await pool.query("delete from spend_events where ref = $1", [RUN_ID]);
  await pool.query("delete from ingestion_runs where apify_run_id = $1", [RUN_ID]);
  await pool.query("delete from seen_items where natural_id like 'job:indeed:%' and natural_id in ($1, $2)", ["job:indeed:d5eb758b439a25d5", "job:indeed:fixture000002"]);
  await pool.query("delete from domain_cache where domain = $1", [DOMAIN]);
  await pool.query("delete from spend_counters where key = $1", [apifyCycleKey(CYCLE)]);
  await pool.query("delete from companies where domain = any($1) or name_key like 'us:resolve test%'", [[R_DOMAIN, TWIN_DOMAIN]]);
  await pool.query("delete from seed_urls where domain = any($1)", [[R_DOMAIN, TWIN_DOMAIN]]);
  await pool.query("delete from resolve_queue where natural_id like $1", [`${R_PREFIX}%`]);
  await pool.query("delete from domain_cache where key like 'resolve test%'");
  await pool.query("delete from ingestion_runs where job_key = 'test-resolve-run'");
  await pool.query("delete from companies where domain like 'age-test%.example'");
  await pool.query("delete from seed_urls where domain like 'age-test%.example'");
  await pool.query("delete from domain_cache where domain like 'age-test%.example'");
  await pool.query("delete from ingestion_runs where job_key = 'test-age-run'");
  await pool.query("delete from companies where domain like 'sniff-test%.example'");
  await pool.query("delete from seed_urls where domain like 'sniff-test%.example'");
  await pool.query("delete from domain_cache where domain like 'sniff-test%.example'");
  await pool.query("delete from ingestion_runs where job_key = 'test-sniff-run'");
  await pool.query("delete from rotation_days where day = $1", [ROTATION_DAY.toISOString().slice(0, 10)]);
  await pool.query("delete from companies where name_key like 'us:li test freight%' or name_key like 'us:li test beta%'");
  await pool.query("delete from resolve_queue where natural_id like 'comment:linkedin:76000000000000000%'");
  await pool.query("delete from domain_cache where key like 'li test beta%'");
  await pool.query("delete from resolve_queue where natural_id like 'post:linkedin:%' and payload::text like '%Li Test Freight%'");
  await pool.query("delete from domain_cache where key like 'li test freight%'");
  await pool.query("delete from eval_cases where headline like '%Li Test Freight%'");
  await pool.query("delete from drop_samples where natural_id like 'job:indeed:leaktest%'");
  await pool.query("delete from alerts where day = '2000-01-04'");
  await pool.query("delete from trie_proposals where phrase like 'leaktest %'");
  await pool.query("delete from drift_checks where day = '2000-01-05'");
  // Arms the tests' runs created (typed titles), once their runs are gone.
  await pool.query("delete from search_arms a where a.source = 'manual' and not exists (select 1 from run_arms ra where ra.run_id is not null and ra.arm_id = a.id)");
}

// Remote database (~100 ms per round trip), so generous timeouts.
describe.skipIf(!process.env.DATABASE_URL)("worker pipeline (database)", { timeout: 60_000 }, () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createPool(2);
    await cleanup(pool);
  }, 60_000);
  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  }, 60_000);

  it("Apify gate refuses a run that would cross the cycle cap, and defers it (§5.3, Sprint 1 acceptance)", async () => {
    // $4.499 already used of a $4.50 cap: a 10-item run (worst case $0.002) must not start.
    const { deps, sent, started } = fakes(pool, { usageUsd: 4.499 });
    const out = await startBoardRun(deps, { country: "us", title: "accounts payable", vertical: "logistics", limit: 10 }, "test-key-deferred");
    expect(out).toEqual({ deferred: true });
    expect(started).toHaveLength(0);
    expect(sent[0]).toMatchObject({ queue: Q.startBoardRun, opts: { startAfter: 3600 } });
    const counter = (await pool.query("select total_usd from spend_counters where key = $1", [apifyCycleKey(CYCLE)])).rows[0];
    expect(Number(counter.total_usd)).toBeCloseTo(4.499, 6); // nothing reserved
    await pool.query("delete from spend_counters where key = $1", [apifyCycleKey(CYCLE)]);
  });

  it("start → run event → fetch → extract → scored card, with exact cost settled", async () => {
    const { deps, sent, started } = fakes(pool);

    const job = { country: "us", title: "accounts payable", vertical: "logistics", limit: 10 } as const;
    expect(await startBoardRun(deps, job, "test-key-1")).toEqual({ started: RUN_ID });
    // pg-boss retries the same job (e.g. it expired after Apify started): no second paid run.
    expect(await startBoardRun(deps, job, "test-key-1")).toEqual({ started: RUN_ID });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ country: "us", title: "accounts payable", datePosted: "14" });
    const reserved = Number((await pool.query("select total_usd from spend_counters where key = $1", [apifyCycleKey(CYCLE)])).rows[0].total_usd);
    expect(reserved).toBeCloseTo(0.002, 6); // 10 × $0.0001 + $0.001

    expect(await onApifyRunEvent(deps, { apifyRunId: RUN_ID })).toBe("SUCCEEDED");
    expect(await onApifyRunEvent(deps, { apifyRunId: RUN_ID })).toBe("already handled"); // webhook + poll both arrive
    const settled = Number((await pool.query("select total_usd from spend_counters where key = $1", [apifyCycleKey(CYCLE)])).rows[0].total_usd);
    expect(settled).toBeCloseTo(0.0012, 6); // exact: 2 items + start
    const fetchJob = sent.find((s) => s.queue === Q.fetchDataset)!;

    const counts = await fetchDataset(deps, fetchJob.data);
    // Item 0 (real, no employer name) → unresolved; item 1 → extract job.
    expect(counts).toMatchObject({ raw_items_ingested: 2, dropped_unresolved_count: 1 });
    const extractJob = sent.find((s) => s.queue === Q.extractLlm)!;
    expect(extractJob.data.post.company).toBe("Acme Freight LLC");

    // Second delivery of the same page: everything is a duplicate now.
    expect(await fetchDataset(deps, fetchJob.data)).toMatchObject({ dropped_dedup_count: 2 });

    expect(await extractLlm(deps, extractJob.data)).toBe(`persisted ${DOMAIN}`);
    expect(await extractLlm(deps, extractJob.data)).toBe(`persisted ${DOMAIN}`); // retry-safe: no second challenge
    const co = (await pool.query("select id, priority_score, size_tier, size_source, vertical from companies where domain = $1", [DOMAIN])).rows[0];
    expect(co).toMatchObject({ priority_score: 78, size_tier: "smb", size_source: "job_board", vertical: "logistics" });
    const n = (await pool.query("select count(*)::int n from challenges where company_id = $1", [co.id])).rows[0].n;
    expect(n).toBe(1);
    const run = (await pool.query("select status, raw_items_ingested, llm_persisted_count from ingestion_runs where apify_run_id = $1", [RUN_ID])).rows[0];
    expect(run).toMatchObject({ status: "done", raw_items_ingested: 4, llm_persisted_count: 1 });
  });

  it("settles the real cost when the run's charge counts lag behind its items", async () => {
    const { deps } = fakes(pool, { lagging: true });
    await pool.query("delete from ingestion_runs where apify_run_id = $1", [RUN_ID]);
    await pool.query("delete from spend_counters where key = $1", [apifyCycleKey(CYCLE)]);
    await startBoardRun(deps, { country: "us", title: "accounts payable", vertical: "logistics", limit: 10 }, "test-key-lag");
    expect(await onApifyRunEvent(deps, { apifyRunId: RUN_ID })).toBe("SUCCEEDED");
    const settled = Number((await pool.query("select total_usd from spend_counters where key = $1", [apifyCycleKey(CYCLE)])).rows[0].total_usd);
    expect(settled).toBeCloseTo(0.0012, 6); // 2 items from the dataset + start, not the start alone
    await pool.query("delete from ingestion_runs where apify_run_id = $1", [RUN_ID]);
    await pool.query("delete from spend_events where ref = $1", [RUN_ID]);
  });

  it("LinkedIn post search: posts and comments saved, fresh posts read, sharers marked, contacts kept, own pain posts carded (§4.1d)", async () => {
    await pool.query("delete from ingestion_runs where apify_run_id = $1", [RUN_ID]);
    const P1 = act(new Date(NOW.getTime() - 2 * 86_400_000)); // fresh, with comments
    const P2 = act(new Date(NOW.getTime() - 3 * 86_400_000)); // fresh, no pain
    const P3 = act(new Date(NOW.getTime() - 40 * 86_400_000)); // too old
    const P4 = act(new Date(NOW.getTime() - 4 * 86_400_000)); // pain, but a vendor selling
    const P5 = act(new Date(NOW.getTime() - 5 * 86_400_000)); // pain at their own business, outside our markets
    const post = (id: string, content: string) => ({
      type: "post", id, linkedinUrl: `https://www.linkedin.com/posts/li-test_x-activity-${id}-Ab1`, content,
      author: { type: "profile", name: "Li Test Author", info: "Operations Manager at Li Test Freight | ops@litest.example", linkedinUrl: "https://www.linkedin.com/in/li-test-author" },
      postedAt: { timestamp: Number(BigInt(id) >> 22n) }, engagement: { likes: 4, comments: 2, shares: 0 },
    });
    const comment = (id: string, postId: string, commentary: string, author = false) => ({
      type: "comment", id, postId, commentary, createdAt: NOW.toISOString(),
      actor: { type: "profile", name: `Commenter ${id.slice(-2)}`, position: "AP Lead at Li Test Beta", linkedinUrl: `https://www.linkedin.com/in/c-${id.slice(-2)}`, author },
      engagement: { likes: Number(id.slice(-1)) },
    });
    const liItems = [
      post(P1, "We still check every freight invoice by hand."),
      post(P2, "Great quarter, thanks team."),
      post(P3, "Old post."),
      post(P4, "Still checking invoices manually? Book a demo of our tool."),
      post(P5, "Our London office keys every invoice manually."),
      comment("7600000000000000001", P1, "Same here, a week a month on this."),
      comment("7600000000000000002", P1, "Great post!"),
      comment("7600000000000000003", P1, "Thanks all", true), // the author replying: not a contact, not read
    ];
    // The fake AI answers by what the prompt holds; comments come in likes order (c1 = …02, c2 = …01).
    const noPain = { urgency: "none", own_experience: false, specifics: false, current_process: false, consequence: false };
    const weekly = { urgency: "recurring", own_experience: true, specifics: false, current_process: false, consequence: false };
    const liRead = (user: string) =>
      user.includes("Book a demo")
        ? { has_pain: true, pains: ["Invoices checked manually"], author_relation: "vendor", stance: "selling", author_company: "Li Test Vendor", author_country: "us", comments: [] }
      : user.includes("London")
        ? { has_pain: true, pains: ["Invoices keyed manually"], author_relation: "employee", stance: "suffering", author_company: "Li Test Freight", author_country: "other", comments: [] }
      : user.includes("by hand")
        ? {
            has_pain: true, pains: ["Freight invoices checked by hand"], author_relation: "employee", stance: "suffering", author_company: "Li Test Freight", author_country: "us",
            comments: [
              { ref: "c1", resonates: false, reply_kind: "unhelpful", gist: "Praise", company: "Li Test Beta", relation: "employee", country: "us", ...noPain },
              { ref: "c2", resonates: true, reply_kind: "shares", gist: "Spends a week a month checking invoices", company: "Li Test Beta", relation: "employee", country: "us", ...weekly },
              { ref: "c9", resonates: true, reply_kind: "shares", gist: "not in the prompt", company: null, relation: "employee", country: "us", ...weekly },
            ],
          }
        : { has_pain: false, pains: ["ignored when no pain"], author_relation: "employee", stance: "commenting", author_company: null, author_country: "unknown", comments: [] };
    const { deps, sent, started, archived } = fakes(pool, { dataset: liItems, liRead });
    const job = { vertical: "logistics" as const, topics: ["freight invoices"], posts: 5, comments: 10 };
    expect(await startLiRun(deps, job, "test-li-key")).toEqual({ started: RUN_ID });
    expect(await startLiRun(deps, job, "test-li-key")).toEqual({ started: RUN_ID }); // retry: no second run
    expect(started).toEqual([expect.objectContaining({ searchQueries: ['"freight invoices" NOT AI NOT software NOT automation NOT platform NOT demo'], maxPosts: 5, maxComments: 10, scrapeComments: true })]);
    // Completion is checked 20 s after the start, not at the next 5-minute poll.
    expect(sent.find((s) => s.queue === Q.apifyRunEvent)).toMatchObject({ data: { apifyRunId: RUN_ID, recheck: 30 }, opts: { startAfter: 20 } });

    // Seconds after the run ends its dataset can still read empty: look again before settling.
    const early = fakes(pool, { dataset: [] });
    expect(await onApifyRunEvent(early.deps, { apifyRunId: RUN_ID, recheck: 30 })).toBe("waiting for final counts");
    expect(early.sent).toEqual([{ queue: Q.apifyRunEvent, data: { apifyRunId: RUN_ID, recheck: 3 }, opts: { startAfter: 10 } }]);
    expect(await onApifyRunEvent(deps, { apifyRunId: RUN_ID })).toBe("SUCCEEDED");
    const runRow = (await pool.query("select id, job_type, query_title from ingestion_runs where apify_run_id = $1", [RUN_ID])).rows[0];
    expect(runRow).toMatchObject({ job_type: "li_posts", query_title: "freight invoices" });
    // The run is linked to its topic's arm, so the bandit learns from it (§4.1c).
    const arms = (await pool.query("select a.kind, a.country, a.term, a.grp from run_arms ra join search_arms a on a.id = ra.arm_id where ra.run_id = $1", [runRow.id])).rows;
    expect(arms).toEqual([{ kind: "social", country: "all", term: "freight invoices", grp: "medium" }]);
    // 8 items × $0.002 + the start: every post and comment is one event.
    const spent = Number((await pool.query("select sum(cost_usd) s from spend_events where run_id = $1", [runRow.id])).rows[0].s);
    expect(spent).toBeCloseTo(8 * 0.002 + 0.00005, 6);

    const counts = await fetchLiRun(deps, sent.find((x) => x.queue === Q.fetchLiRun)!.data);
    // The raw items are archived (Q64) under the run, as fetched, for re-runs.
    expect(archived).toEqual([{ source: "li_posts", day: NOW.toISOString().slice(0, 10), runId: runRow.id, part: "all", items: liItems }]);
    expect(counts).toMatchObject({ raw_items_ingested: 5, dropped_stale_count: 1, dropped_trie_count: 0 });
    const reads = sent.filter((x) => x.queue === Q.readLiPost);
    expect(reads).toHaveLength(4);
    for (const r of reads) await readLiPost(deps, r.data);
    expect(await readLiPost(deps, reads[0]!.data)).toBe("already read");

    const posts = (await pool.query("select post_id, status, has_pain, pains, author_company, author_country, card_outcome, emails from li_posts where run_id = $1", [runRow.id])).rows;
    const byId = Object.fromEntries(posts.map(({ post_id, ...p }) => [post_id, p]));
    expect(byId).toEqual({
      [P1]: { status: "read", has_pain: true, pains: ["Freight invoices checked by hand"], author_company: "Li Test Freight", author_country: "us", card_outcome: "checking", emails: ["ops@litest.example"] },
      [P2]: { status: "read", has_pain: false, pains: [], author_company: null, author_country: "unknown", card_outcome: "no_pain", emails: ["ops@litest.example"] },
      [P4]: { status: "read", has_pain: true, pains: ["Invoices checked manually"], author_company: "Li Test Vendor", author_country: "us", card_outcome: "not_own", emails: ["ops@litest.example"] },
      [P5]: { status: "read", has_pain: true, pains: ["Invoices keyed manually"], author_company: "Li Test Freight", author_country: "other", card_outcome: "no_market", emails: ["ops@litest.example"] },
    });
    const comments = (await pool.query(
      "select k.comment_id, k.is_author, k.resonates, k.reply_kind, k.gist, k.company, k.pain_score, k.signals from li_comments k join li_posts p on p.id = k.li_post_id where p.run_id = $1 order by k.comment_id",
      [runRow.id],
    )).rows;
    expect(comments).toEqual([
      // recurring 70 × 0.6 + own experience 35 × 0.4 = 56; praise scores 0.
      { comment_id: "7600000000000000001", is_author: false, resonates: true, reply_kind: "shares", gist: "Spends a week a month checking invoices", company: "Li Test Beta", pain_score: 56, signals: ["own_experience"] },
      { comment_id: "7600000000000000002", is_author: false, resonates: false, reply_kind: "unhelpful", gist: "Praise", company: "Li Test Beta", pain_score: 0, signals: [] },
      { comment_id: "7600000000000000003", is_author: true, resonates: null, reply_kind: null, gist: null, company: null, pain_score: null, signals: [] },
    ]);
    // The commenter who shares the pain, at their own company in our markets, gets a card of
    // their own; the praise does not.
    const commentCards = sent.filter((x) => x.queue === Q.cardLiComment);
    expect(commentCards).toHaveLength(1);
    const k = (await pool.query("select comment_id, relation, country, card_outcome from li_comments where id = $1", [commentCards[0]!.data.liCommentId])).rows[0];
    expect(k).toEqual({ comment_id: "7600000000000000001", relation: "employee", country: "us", card_outcome: "checking" });
    expect((await pool.query("select card_outcome from li_comments where comment_id = '7600000000000000002'")).rows[0].card_outcome).toBe("no_pain");
    expect(await cardLiComment(deps, commentCards[0]!.data)).toMatch(/^persisted/);
    expect(await cardLiComment(deps, commentCards[0]!.data)).toBe("already decided");
    const kc = (
      await pool.query(
        `select ch.source_type, ch.author_relation, ch.evidence_snippet, ch.structured_intelligence ->> 'stance' stance, c.company_name, c.country
           from challenges ch join companies c on c.id = ch.company_id where ch.natural_id = 'comment:linkedin:7600000000000000001'`,
      )
    ).rows[0];
    expect(kc).toEqual({ source_type: "linkedin_post", author_relation: "employee", evidence_snippet: "Same here, a week a month on this.", stance: "suffering", company_name: "Li Test Beta", country: "us" });
    expect((await pool.query("select card_outcome from li_comments where comment_id = '7600000000000000001'")).rows[0].card_outcome).toBe("card");
    await pool.query("delete from resolve_queue where natural_id = 'comment:linkedin:7600000000000000001'");

    // Only the own-business pain post in our markets goes on to a card.
    const cards = sent.filter((x) => x.queue === Q.cardLiPost);
    expect(cards).toHaveLength(1);
    expect((await pool.query("select llm_persisted_count p from ingestion_runs where id = $1", [runRow.id])).rows[0].p).toBe(1); // the commenter's card; a pain post is not a card until carded
    expect(await cardLiPost(deps, cards[0]!.data)).toMatch(/^persisted/);
    expect(await cardLiPost(deps, cards[0]!.data)).toBe("already decided");
    const ch = (
      await pool.query(
        `select ch.source_type, ch.author_relation, ch.run_id, ch.evidence_snippet, c.company_name, c.country, c.vertical
           from challenges ch join companies c on c.id = ch.company_id where ch.natural_id = $1`,
        [`post:linkedin:${P1}`],
      )
    ).rows[0];
    expect(ch).toEqual({ source_type: "linkedin_post", author_relation: "employee", run_id: runRow.id, evidence_snippet: "We still check every freight invoice by hand.", company_name: "Li Test Freight", country: "us", vertical: "logistics" });
    expect((await pool.query("select card_outcome from li_posts where post_id = $1", [P1])).rows[0].card_outcome).toBe("card");
    expect((await pool.query("select llm_persisted_count p from ingestion_runs where id = $1", [runRow.id])).rows[0].p).toBe(2); // the commenter's and the author's
    // The same post found again (another topic or run) costs no second AI call and adds no card.
    await pool.query("update li_posts set card_outcome = 'checking' where post_id = $1", [P1]);
    expect(await cardLiPost(deps, cards[0]!.data)).toBe("duplicate");
    await pool.query("delete from resolve_queue where natural_id = $1", [`post:linkedin:${P1}`]);

    // The operator labels a post for the AI test set: copied without the author's name or email.
    const p1 = (await pool.query("select id from li_posts where post_id = $1", [P1])).rows[0].id;
    expect(await withTransaction(pool, (c) => labelLiPost(c, p1, "lead"))).toBe(true);
    expect(await withTransaction(pool, (c) => labelLiPost(c, p1, "pain"))).toBe(true); // a change of mind replaces it
    const ec = (await pool.query("select text, headline, label from eval_cases where li_post_id = $1", [p1])).rows;
    expect(ec).toEqual([{ text: "We still check every freight invoice by hand.", headline: "Operations Manager at Li Test Freight | [email]", label: "pain" }]);
    expect(await withTransaction(pool, (c) => labelLiPost(c, p1, null))).toBe(true);
    expect((await pool.query("select count(*)::int n from eval_cases where li_post_id = $1", [p1])).rows[0].n).toBe(0);
    await pool.query("delete from ingestion_runs where apify_run_id = $1", [RUN_ID]); // posts and comments go with it
    await pool.query("delete from spend_events where ref = $1", [RUN_ID]);
  });

  it("leak check: sampled trie drops read daily, real leads' phrases proposed, decided by the operator (§6.3 step 6)", async () => {
    const sample = (n: number) =>
      recordDropSample(pool, { runId: null as unknown as string, naturalId: `job:indeed:leaktest${n}`, vertical: "logistics", country: "us", title: "Office Assistant", text: `Day ${n}: leaktest rekey orders by hand, call pat@x.example or +1 555 010 0000.` });
    await sample(1);
    await sample(1); // a retried fetch adds nothing
    await sample(2);
    expect((await pool.query("select count(*)::int n, min(text) t from drop_samples where natural_id like 'job:indeed:leaktest%'")).rows[0]).toEqual({ n: 2, t: "Day 1: leaktest rekey orders by hand, call [email] or [phone]." });
    const leak = () => ({ is_lead: true, reason: "Re-keying orders", phrases: [{ phrase: "leaktest rekey orders", category: "INTEGRATION_DEBT" }, { phrase: "leaktest not in the post", category: "AUTOMATABLE_TASK" }] });
    const { deps } = fakes(pool, { leak });
    const mine = "job:indeed:leaktest"; // the audit reads this test's samples only, never real ones
    expect(await auditDropped(deps, mine)).toEqual({ checked: 2, leads: 2, phrases: 2 });
    const p = (await pool.query("select id, phrase, category, vertical, status, evidence, cardinality(examples) ex from trie_proposals where phrase like 'leaktest %'")).rows;
    expect(p.map(({ id: _id, ...x }) => x)).toEqual([{ phrase: "leaktest rekey orders", category: "INTEGRATION_DEBT", vertical: "logistics", status: "proposed", evidence: 2, ex: 2 }]);

    // The operator rejects it (as the UI does, under RLS); the database records the evidence.
    await withTransaction(pool, async (c) => {
      await c.query("set local role authenticated");
      await c.query("update trie_proposals set status = 'rejected', reason = 'too broad' where id = $1", [p[0].id]);
    });
    expect((await pool.query("select status, evidence_at_decision from trie_proposals where id = $1", [p[0].id])).rows[0]).toEqual({ status: "rejected", evidence_at_decision: 2 });
    // It comes back only once its evidence doubles (2 → 4).
    await sample(3);
    await auditDropped(deps, mine);
    expect((await pool.query("select status from trie_proposals where id = $1", [p[0].id])).rows[0].status).toBe("rejected");
    await sample(4);
    await auditDropped(deps, mine);
    expect((await pool.query("select status, evidence from trie_proposals where id = $1", [p[0].id])).rows[0]).toEqual({ status: "proposed", evidence: 4 });

    // Approved, it is in the trie's extra atoms.
    await withTransaction(pool, async (c) => {
      await c.query("set local role authenticated");
      await c.query("update trie_proposals set status = 'approved' where id = $1", [p[0].id]);
    });
    expect((await approvedAtoms(pool)).vertical.logistics?.INTEGRATION_DEBT).toContain("leaktest rekey orders");
  });

  it("daily alerts: saved for /health, emailed once when a mailer is set, a failed email loses nothing (Q65)", async () => {
    const day = new Date("2000-01-04T06:00:00Z"); // test-only key; the inputs are the live 24 h
    const mails: { subject: string; text: string }[] = [];
    const base = { ...fakes(pool).deps, now: () => day };
    // Rotation on, so "no cards" can fire whatever today's data: there is at least one alert to check.
    const settings = { ...base.settings, rotationEnabled: true };
    await pool.query("insert into ingestion_runs (job_key, job_type, status, started_at) values ('test-alert-run', 'indeed', 'failed', now())");
    try {
      const sent = await dailyAlertsJob({ ...base, settings, mailer: { send: async (m) => void mails.push(m) } });
      expect(sent.emailed).toBe(true);
      expect(mails).toHaveLength(1);
      expect(mails[0]!.text).toContain("Runs failed in the last 24 hours");
      const rows = (await pool.query("select kind, emailed from alerts where day = '2000-01-04'")).rows;
      expect(rows.some((r) => r.kind === "failed_runs" && r.emailed)).toBe(true);
      // The email provider down: the alerts are still saved, marked not emailed.
      await pool.query("delete from alerts where day = '2000-01-04'");
      const failed = await dailyAlertsJob({ ...base, settings, mailer: { send: async () => { throw new Error("resend 500"); } } });
      expect(failed.emailed).toBe(false);
      expect((await pool.query("select bool_or(emailed) e, count(*)::int n from alerts where day = '2000-01-04'")).rows[0]).toEqual({ e: false, n: failed.alerts });
    } finally {
      await pool.query("delete from ingestion_runs where job_key = 'test-alert-run'");
    }
  });

  it("drift check: every health number judged and stored once a day, free (agreed 2026-11-08)", async () => {
    const day = new Date("2000-01-05T05:30:00Z"); // test-only: nothing happened in the weeks before it
    const out = await driftCheck({ pool, now: () => day, log: () => {} });
    expect(out).toEqual({ moved: [] });
    await driftCheck({ pool, now: () => day, log: () => {} }); // a re-run the same day replaces the rows
    const rows = (await pool.query("select metric, verdict from drift_checks where day = '2000-01-05' order by metric")).rows;
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.verdict === "too_few")).toBe(true);
    await pool.query("delete from drift_checks where day = '2000-01-05'");
  });

  it("ingest-rotation: off by default; when on, the bandit plans the day once (§4.1c)", async () => {
    expect(await ingestRotation(fakes(pool).deps)).toEqual({ skipped: "ROTATION_ENABLED is off" });
    const { deps, sent } = fakes(pool, { rotation: true, now: ROTATION_DAY });
    const out = await ingestRotation(deps);
    expect("planned" in out && out.planned.job).toHaveLength(3);
    const starts = sent.filter((s) => s.queue === Q.startBoardRun);
    expect(starts).toHaveLength(3);
    expect(starts[0]!.data).toMatchObject({ limit: 35, title: expect.any(String) });
    // ≥ half the day's 4 runs on High/Medium searches: the social run plus at least one fixer search.
    expect(starts.filter((s) => s.data.vertical === null).length).toBeGreaterThanOrEqual(1);
    // The social slot runs LinkedIn post search on the bandit's topics (§4.1d).
    const social = sent.filter((s) => s.queue === Q.startLiRun);
    expect(social).toHaveLength(1);
    expect(social[0]!.data).toMatchObject({ posts: 5, comments: 5, vertical: expect.any(String) });
    expect(social[0]!.data.topics.length).toBeGreaterThan(0);
    expect(social[0]!.data.topics.length).toBeLessThanOrEqual(2);
    // A retried cron job the same day starts nothing more.
    expect(await ingestRotation(deps)).toEqual({ skipped: "already planned today" });
    expect(sent.filter((s) => s.queue === Q.startBoardRun)).toHaveLength(3);
  });

  it("runs link to their searches and cards to their run, so a rejection counts against the search (§4.1c)", async () => {
    const { linked } = await syncSearchArms({ pool });
    expect(linked).toBeGreaterThanOrEqual(0);
    const arms = (await pool.query("select count(*)::int n from search_arms where source = 'seed'")).rows[0].n;
    expect(arms).toBeGreaterThanOrEqual(45 * 3 + 18 + 45 * 20);
    // Every run from before the bandit with a title is linked, LinkedIn post searches included.
    const unlinked = (
      await pool.query(
        `select count(*)::int n from ingestion_runs r where r.query_title is not null and r.job_type in ('indeed', 'linkedin', 'li_posts')
            and (r.country is not null or r.job_type = 'li_posts') and not exists (select 1 from run_arms ra where ra.run_id = r.id)`,
      )
    ).rows[0].n;
    expect(unlinked).toBe(0);
  });

  it("unknown employee count → domain age tags the size, asked once per domain, never drops (§6.7)", async () => {
    const runId = (await pool.query("insert into ingestion_runs (job_key, job_type, country, status) values ('test-age-run', 'indeed', 'us', 'done') returning id")).rows[0].id;
    const job = (n: string, company: string, boardWebsite: string, boardEmployeeBand: string | null = null) => ({
      runId,
      vertical: "logistics" as const,
      founderDependency: false,
      post: {
        naturalId: `${AGE_PREFIX}${n}`, url: "https://www.indeed.com/viewjob?jk=x", title: "AP Clerk", company,
        description: "Key freight invoices into QuickBooks.", postedAt: NOW.toISOString(), city: "Houston", country: "us" as const,
        boardWebsite, boardEmployeeBand,
      },
    });
    const sizeOf = async (domain: string) =>
      (await pool.query("select size_tier, size_source, domain_registered_at::text d from companies where domain = $1", [domain])).rows[0];

    // Registered 2 years before NOW → Startup, and the date is stored.
    const a = fakes(pool, { ages: { [AGE_DOMAIN]: new Date("2024-10-01T00:00:00Z") } });
    expect(await extractLlm(a.deps, job("1", "Age Test Co", `https://www.${AGE_DOMAIN}/`))).toBe(`persisted ${AGE_DOMAIN}`);
    expect(await sizeOf(AGE_DOMAIN)).toEqual({ size_tier: "startup", size_source: "domain_age", d: "2024-10-01" });
    expect(a.rdapCalls).toEqual([AGE_DOMAIN]);

    // Second post, same domain: the stored date is used, the registry is not asked again.
    const b = fakes(pool, { ages: { [AGE_DOMAIN]: "error" } });
    await extractLlm(b.deps, job("2", "Age Test Co", `https://${AGE_DOMAIN}`));
    expect(b.rdapCalls).toEqual([]);
    expect((await sizeOf(AGE_DOMAIN)).size_tier).toBe("startup");

    // A fixer hire (§1.1) runs with no vertical: the AI reads it from the post, and the tier is High.
    const fixerDomain = "age-test-fixer.example";
    const fixer = { ...job("fixer", "Fixer Test Co", `https://${fixerDomain}`), vertical: null };
    fixer.post.title = "Chief of Staff";
    expect(await extractLlm(fakes(pool).deps, fixer)).toBe(`persisted ${fixerDomain}`);
    const fx = (await pool.query("select c.vertical, ch.urgency_tier from challenges ch join companies c on c.id = ch.company_id where c.domain = $1", [fixerDomain])).rows[0];
    expect(fx).toEqual({ vertical: "construction", urgency_tier: "high" });

    // Lookup fails → size unknown, card still made. Old domain → unknown too. Known band → no lookup.
    const c = fakes(pool, { ages: { "age-test-down.example": "error", "age-test-old.example": new Date("2002-07-29T00:00:00Z") } });
    expect(await extractLlm(c.deps, job("3", "Age Down Co", "https://age-test-down.example"))).toBe("persisted age-test-down.example");
    expect(await sizeOf("age-test-down.example")).toEqual({ size_tier: "unknown", size_source: "none", d: null });
    await extractLlm(c.deps, job("4", "Age Old Co", "https://age-test-old.example"));
    expect(await sizeOf("age-test-old.example")).toEqual({ size_tier: "unknown", size_source: "none", d: "2002-07-29" });
    await extractLlm(c.deps, job("5", "Age Band Co", "https://age-test-band.example", "11 to 50"));
    expect((await sizeOf("age-test-band.example")).size_tier).toBe("smb");
    expect(c.rdapCalls).toEqual(["age-test-down.example", "age-test-old.example"]);
  });

  it("website sniff: saves the audit, adds a website challenge only for manual intake, rescores (§5.4)", async () => {
    const runId = (await pool.query("insert into ingestion_runs (job_key, job_type, country, status) values ('test-sniff-run', 'indeed', 'ae', 'done') returning id")).rows[0].id;
    const post = (n: string, company: string, domain: string) => ({
      runId, vertical: "healthcare" as const, founderDependency: false,
      post: {
        naturalId: `job:indeed:snifftest${n}`, url: "https://ae.indeed.com/viewjob?jk=x", title: "Receptionist", company,
        description: "Book patient appointments by phone.", postedAt: NOW.toISOString(), city: "Dubai", country: "ae" as const,
        boardWebsite: `https://${domain}/`, boardEmployeeBand: "11 to 50",
      },
    });
    const base = auditSite({
      pages: [{ url: "x", $: parseHtml("<body>Clinic</body>"), text: "Clinic" }],
      tech: [], robotsTxt: null, hasLlmsTxt: false, vertical: "healthcare", country: "ae", now: NOW,
    });
    const audit = { ...base, pain: { pdfForms: [{ url: `https://${SNIFF_DOMAIN}/intake.pdf`, label: "Patient intake form" }], mailtoOnly: false, noScheduling: true },
      contacts: { emails: ["info@sniff-test.example"], whatsapp: ["+971500000000"], phones: [], sourceUrl: `https://${SNIFF_DOMAIN}/contact` } };
    const tech = [{ name: "WordPress", version: null, categories: ["CMS"], saas: false }];
    const q = fakes(pool, {
      sniffs: {
        [SNIFF_DOMAIN]: { reachable: true, finalUrl: `https://${SNIFF_DOMAIN}/`, pages: [`https://${SNIFF_DOMAIN}/`], tech, audit },
        "sniff-test-down.example": { reachable: false, reason: "no HTML response" },
      },
    });
    await extractLlm(q.deps, post("1", "Sniff Test Clinic", SNIFF_DOMAIN));
    await extractLlm(q.deps, post("2", "Sniff Down Clinic", "sniff-test-down.example"));
    const seedOf = async (d: string) => (await pool.query("select id, status from seed_urls where domain = $1", [d])).rows[0];

    // The cron claims pending seeds; checked in a rolled-back transaction so real seeds stay pending.
    const c = await pool.connect();
    try {
      await c.query("begin");
      const claimed = await claimSeeds(c, 1000);
      expect(claimed.map((s) => s.domain)).toEqual(expect.arrayContaining([SNIFF_DOMAIN, "sniff-test-down.example"]));
      expect(await claimSeeds(c, 1000)).toEqual([]); // nothing claimed twice
    } finally {
      await c.query("rollback");
      c.release();
    }

    const seed = await seedOf(SNIFF_DOMAIN);
    expect(await sniffDomain(q.deps, { seedId: seed.id })).toBe(`sniffed ${SNIFF_DOMAIN}: 1 tech, dom_sniff`);
    expect(await sniffDomain(q.deps, { seedId: seed.id })).toBe(`sniffed ${SNIFF_DOMAIN}: 1 tech, dom_sniff`); // retry-safe
    expect((await seedOf(SNIFF_DOMAIN)).status).toBe("done");
    const co = (await pool.query("select id, reachable, tech_stack, web_ui_audit_flags, contact_email, contact_whatsapp, contact_source_url, priority_score, score_breakdown, last_sniffed_at from companies where domain = $1", [SNIFF_DOMAIN])).rows[0];
    expect(co).toMatchObject({ reachable: true, contact_email: "info@sniff-test.example", contact_whatsapp: "+971500000000", contact_source_url: `https://${SNIFF_DOMAIN}/contact` });
    expect(co.tech_stack).toEqual(tech);
    expect(co.web_ui_audit_flags.pain.pdfForms).toHaveLength(1);
    expect(co.last_sniffed_at).not.toBeNull();
    const ch = (await pool.query("select source_type, signal_score, blast_radius, evidence_snippet from challenges where company_id = $1 and source_type = 'dom_sniff'", [co.id])).rows;
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ signal_score: 44, blast_radius: 0 });
    expect(ch[0].evidence_snippet).toContain("Patient intake form");
    // Two families now (job post + website): M = 10 on top of the job post's score.
    expect(co.score_breakdown).toMatchObject({ M: 10 });
    expect(co.score_breakdown.families.sort()).toEqual(["job_post", "website"]);

    const down = await seedOf("sniff-test-down.example");
    expect(await sniffDomain(q.deps, { seedId: down.id })).toBe("unreachable sniff-test-down.example");
    expect((await seedOf("sniff-test-down.example")).status).toBe("unreachable");
    expect((await pool.query("select reachable, web_ui_audit_flags from companies where domain = 'sniff-test-down.example'")).rows[0]).toEqual({ reachable: false, web_ui_audit_flags: { unreachable: "no HTML response" } });
  });

  it("no website on the board → card now, marked no website → daily search attaches the website (§5.1 step 5)", async () => {
    const runId = (await pool.query("insert into ingestion_runs (job_key, job_type, country, status) values ('test-resolve-run', 'indeed', 'us', 'done') returning id")).rows[0].id;
    const job = (n: string, company: string, postedAt: string, boardWebsite: string | null = null) => ({
      runId,
      vertical: "logistics" as const,
      founderDependency: false,
      post: {
        naturalId: `${R_PREFIX}${n}`, url: "https://www.indeed.com/viewjob?jk=x", title: "AP Clerk", company,
        description: "Key freight invoices into QuickBooks.", postedAt, city: "Houston", country: "us" as const,
        boardWebsite, boardEmployeeBand: null,
      },
    });
    const fresh = NOW.toISOString();
    const QUEUED = "persisted (no website yet, queued for search)";
    const counters = async () => (await pool.query("select dropped_unresolved_count u, dropped_stale_count s, llm_persisted_count p, persisted_no_website_count nw from ingestion_runs where id = $1", [runId])).rows[0];
    const byName = async (key: string) =>
      (await pool.query("select c.domain, c.priority_score, (select count(*)::int from challenges where company_id = c.id) n from companies c where name_key = $1", [key])).rows[0];

    // Every post becomes a card at once, marked no website; a retried job adds nothing.
    const q = fakes(pool, { searchCap: 0 });
    expect(await extractLlm(q.deps, job("1", "Resolve Test Co", fresh))).toBe(QUEUED);
    expect(await extractLlm(q.deps, job("1", "Resolve Test Co", fresh))).toBe(QUEUED);
    expect(await extractLlm(q.deps, job("2", "Resolve Test Other", fresh))).toBe(QUEUED);
    expect(await extractLlm(q.deps, job("3", "Resolve Test Old", "2026-10-01T00:00:00Z"))).toBe(QUEUED);
    expect(await byName("us:resolve test:houston")).toMatchObject({ domain: null, priority_score: 78, n: 1 });

    // Quota 0: nothing searched; the 21-day-old post leaves the queue but keeps its card.
    expect(await resolveBatch(q.deps)).toMatchObject({ stale: 1, searched: 0 });
    expect(await byName("us:resolve test old:houston")).toMatchObject({ domain: null, n: 1 });

    // A domain no search result is on (memory answer) is a miss: the card stays "no website".
    const miss = fakes(pool, { searchCap: 1, resolveTo: { domain: R_DOMAIN, cited: ["https://www.linkedin.com/company/x"] } });
    expect(await resolveBatch(miss.deps)).toMatchObject({ searched: 1, resolved: 0, noWebsite: 1 });
    expect(await resolveBatch(miss.deps)).toMatchObject({ searched: 0 }); // quota used up today

    await pool.query("update resolve_queue set searched_at = searched_at - interval '1 day' where natural_id like $1", [`${R_PREFIX}%`]);
    const hit = fakes(pool, { searchCap: 5, resolveTo: { domain: R_DOMAIN, cited: [`https://www.${R_DOMAIN}/about`] } });
    expect(await resolveBatch(hit.deps)).toMatchObject({ searched: 1, resolved: 1 });
    const checked = (await pool.query("select company_check c from companies where domain = $1", [R_DOMAIN])).rows[0].c;
    expect(checked).toMatchObject({ domain: R_DOMAIN, sizeBand: "11-50", steps: 1, stoppedBy: "finish", costUsd: 0.002 });
    // The same card got its website: no second company, seed URL queued for the sniff.
    expect(await byName("us:resolve test other:houston")).toMatchObject({ domain: R_DOMAIN, n: 1 });
    expect((await pool.query("select count(*)::int n from seed_urls where domain = $1", [R_DOMAIN])).rows[0].n).toBe(1);

    // Known companies never spend a search.
    expect(await extractLlm(hit.deps, job("4", "Resolve Test Co", fresh))).toBe("persisted (no website)");
    expect(await byName("us:resolve test:houston")).toMatchObject({ domain: null, n: 2 });
    expect(await extractLlm(hit.deps, job("5", "Resolve Test Other", fresh))).toBe(`persisted ${R_DOMAIN}`);

    // Two queued posts for one company: one check, the second answered by the cache.
    const twin = fakes(pool, {
      searchCap: 5,
      resolveTo: { domain: TWIN_DOMAIN, cited: [`https://${TWIN_DOMAIN}/`] },
      pages: { [`https://${TWIN_DOMAIN}/`]: "<title>Resolve Test Twin | Freight, Houston TX</title>" },
    });
    expect(await extractLlm(twin.deps, job("6", "Resolve Test Twin", fresh))).toBe(QUEUED);
    expect(await extractLlm(twin.deps, job("7", "Resolve Test Twin", fresh))).toBe(QUEUED);
    expect(await resolveBatch(twin.deps)).toMatchObject({ searched: 1, cached: 1, resolved: 2 });
    expect(await byName("us:resolve test twin:houston")).toMatchObject({ domain: TWIN_DOMAIN, n: 2 });

    // A no-website card whose website turns out to belong to a company we already have: folded in.
    expect(await extractLlm(hit.deps, job("8", "Resolve Test Merge", fresh))).toBe(QUEUED);
    expect(await extractLlm(hit.deps, job("9", "Resolve Test Merge", fresh, `https://${R_DOMAIN}`))).toBe(`persisted ${R_DOMAIN}`);
    expect(await byName("us:resolve test merge:houston")).toBeUndefined();
    expect((await pool.query("select count(*)::int n from challenges ch join companies c on c.id = ch.company_id where c.domain = $1", [R_DOMAIN])).rows[0].n).toBe(4);

    expect(await counters()).toMatchObject({ s: 0, u: 0, p: 9, nw: 7 });
  });
});
