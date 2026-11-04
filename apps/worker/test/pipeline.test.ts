// Worker jobs against the real database with fake Apify + LLM (Q66: fakes for providers).
// Skipped when DATABASE_URL is absent (CI has no database). Every row it writes is removed.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { type LlmClient, type StructuredIntelligence, Q, apifyCycleKey } from "@bs/core";
import { createPool } from "@bs/db";
import type { ApifyRun } from "@bs/integrations";
import { type Deps, type Send, extractLlm, fetchDataset, onApifyRunEvent, startBoardRun } from "../src/jobs.ts";

const items = JSON.parse(readFileSync(new URL("../../../packages/integrations/test/fixtures/indeed-items.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-03T12:00:00Z");
const CYCLE = new Date("2000-01-16T00:00:00Z"); // test-only cycle key, never a real one
const RUN_ID = "testRunFixture01";
const DOMAIN = "acme-freight.example";

const si: StructuredIntelligence = {
  department: "Finance",
  verified_symptom: "Hiring an AP clerk to key freight invoices into QuickBooks by hand",
  inferred_tech_stack: ["QuickBooks"],
  automatable_task_percentage: 70,
  proposed_ai_replacement: "Invoice capture into QuickBooks",
  blast_radius: { frequency: "Daily", urgency_level: "Blocking", founder_dependency_flag: false, estimated_hours_wasted_weekly: 20 },
  automation_fit: "high",
  known_large_brand: false,
  author_relation: null,
  stance: null,
};

function fakes(pool: pg.Pool, over: { usageUsd?: number; capUsd?: number } = {}) {
  const sent: { queue: string; data: any; opts?: object }[] = [];
  const started: object[] = [];
  const run: ApifyRun = {
    id: RUN_ID,
    status: "SUCCEEDED",
    defaultDatasetId: "testDataset01",
    chargedEventCounts: { "apify-default-dataset-item": 2, "apify-actor-start": 1 },
    startedAt: NOW.toISOString(),
  };
  const llm: LlmClient = {
    worstCaseUsd: async () => 0.001,
    json: async (_task, req) => ({ data: req.parse(si) as any, model: "fake/model", costUsd: 0 }),
  };
  const send: Send = async (queue, data, opts) => void sent.push({ queue, data, ...(opts ? { opts } : {}) });
  const deps: Deps = {
    pool,
    apify: {
      usage: async () => ({ cycleStart: CYCLE, cycleEnd: CYCLE, usageUsd: over.usageUsd ?? 0, limitUsd: 5 }),
      startRun: async (_a, input) => (started.push(input), { ...run, status: "READY" }),
      getRun: async () => run,
      datasetItems: async (_id, offset) => (offset === 0 ? items : []) as any,
    },
    llm,
    send,
    settings: { apifyCycleCapUsd: over.capUsd ?? 4.5 },
    now: () => NOW,
    log: () => {},
  };
  return { deps, sent, started };
}

async function cleanup(pool: pg.Pool) {
  await pool.query("delete from companies where domain = $1", [DOMAIN]);
  await pool.query("delete from seed_urls where domain = $1", [DOMAIN]);
  await pool.query("delete from spend_events where ref = $1", [RUN_ID]);
  await pool.query("delete from ingestion_runs where apify_run_id = $1", [RUN_ID]);
  await pool.query("delete from seen_items where natural_id like 'job:indeed:%' and natural_id in ($1, $2)", ["job:indeed:d5eb758b439a25d5", "job:indeed:fixture000002"]);
  await pool.query("delete from domain_cache where domain = $1", [DOMAIN]);
  await pool.query("delete from spend_counters where key = $1", [apifyCycleKey(CYCLE)]);
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
});
