// Worker jobs against the real database with fake Apify + LLM (Q66: fakes for providers).
// Skipped when DATABASE_URL is absent (CI has no database). Every row it writes is removed.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { type LlmClient, type StructuredIntelligence, Q, apifyCycleKey, auditSite, parseHtml } from "@bs/core";
import { claimSeeds, createPool } from "@bs/db";
import type { ApifyRun, SniffResult } from "@bs/integrations";
import { type Deps, type Send, extractLlm, fetchDataset, ingestRotation, onApifyRunEvent, resolveBatch, sniffDomain, startBoardRun } from "../src/jobs.ts";

const items = JSON.parse(readFileSync(new URL("../../../packages/integrations/test/fixtures/indeed-items.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-03T12:00:00Z");
const CYCLE = new Date("2000-01-16T00:00:00Z"); // test-only cycle key, never a real one
const ROTATION_DAY = new Date("2000-01-02T02:00:00Z"); // test-only rotation day
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
  known_large_brand: false,
  author_relation: null,
  stance: null,
};

function fakes(
  pool: pg.Pool,
  over: { usageUsd?: number; capUsd?: number; searchCap?: number; resolveTo?: { domain: string | null; cited: string[]; confidence?: "high" | "low" }; pages?: Record<string, string>;
    ages?: Record<string, Date | null | "error">;
    sniffs?: Record<string, SniffResult>;
    lagging?: boolean; rotation?: boolean; now?: Date } = {},
) {
  const sent: { queue: string; data: any; opts?: object }[] = [];
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
        ? { data: req.parse({ domain: over.resolveTo?.domain ?? null, confidence: over.resolveTo?.confidence ?? "high" }) as any, model: "fake/model", costUsd: 0, citations: over.resolveTo?.cited ?? [] }
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
      datasetItems: async (_id, offset) => (offset === 0 ? items : []) as any,
      datasetItemCount: async () => items.length,
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
    send,
    settings: {
      apifyCycleCapUsd: over.capUsd ?? 4.5,
      searchDailyCap: over.searchCap ?? 15,
      rotationEnabled: over.rotation ?? false,
      boardSlotsPerDay: 3,
      boardPostsPerSlot: 35,
    },
    now: () => over.now ?? NOW,
    log: () => {},
  };
  return { deps, sent, started, rdapCalls };
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

  it("ingest-rotation: off by default; when on, plans the day's slots once (§4.1)", async () => {
    expect(await ingestRotation(fakes(pool).deps)).toEqual({ skipped: "ROTATION_ENABLED is off" });
    const { deps, sent } = fakes(pool, { rotation: true, now: ROTATION_DAY });
    const out = await ingestRotation(deps);
    expect("planned" in out && out.planned).toHaveLength(3);
    const starts = sent.filter((s) => s.queue === Q.startBoardRun);
    expect(starts).toHaveLength(3);
    expect(starts[0]!.data).toMatchObject({ limit: 35, title: expect.any(String), vertical: expect.any(String) });
    // A retried cron job the same day starts nothing more.
    expect(await ingestRotation(deps)).toEqual({ skipped: "already planned today" });
    expect(sent.filter((s) => s.queue === Q.startBoardRun)).toHaveLength(3);
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
    // The same card got its website: no second company, seed URL queued for the sniff.
    expect(await byName("us:resolve test other:houston")).toMatchObject({ domain: R_DOMAIN, n: 1 });
    expect((await pool.query("select count(*)::int n from seed_urls where domain = $1", [R_DOMAIN])).rows[0].n).toBe(1);

    // Known companies never spend a search.
    expect(await extractLlm(hit.deps, job("4", "Resolve Test Co", fresh))).toBe("persisted (no website)");
    expect(await byName("us:resolve test:houston")).toMatchObject({ domain: null, n: 2 });
    expect(await extractLlm(hit.deps, job("5", "Resolve Test Other", fresh))).toBe(`persisted ${R_DOMAIN}`);

    // Unsure pick rescued by the free homepage check; two queued posts, one search.
    const twin = fakes(pool, {
      searchCap: 5,
      resolveTo: { domain: TWIN_DOMAIN, confidence: "low", cited: [`https://${TWIN_DOMAIN}/`] },
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
