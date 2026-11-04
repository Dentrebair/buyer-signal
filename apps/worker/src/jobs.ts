// Job handlers for Flow A (PRD §5.1). Each takes its dependencies explicitly so tests can run
// them with fakes; main.ts wires the real ones. Every handler is safe to run twice (§5.3a).
import type pg from "pg";
import {
  type ApifyRunEvent,
  type ExtractLlm,
  type FetchDataset,
  type LlmClient,
  type QueueName,
  type RawJobPost,
  type StartBoardRun,
  Q,
  apifyChargeCap,
  apifyCycleKey,
  bareDomain,
  blastRadius,
  buildJobExtraction,
  checkFreshness,
  classifySize,
  domainCacheKey,
  gateJobPost,
  signalScore,
  weightsFor,
  worstCaseApifyCost,
} from "@bs/core";
import {
  type DropCounter,
  bumpCounters,
  cacheDomain,
  cachedDomain,
  claimRun,
  createRun,
  getRunByApifyId,
  insertChallenge,
  insertSeedUrl,
  markSeen,
  reconcileApifyCycle,
  recomputeCompanyScore,
  reserveApifyRun,
  seedApifyCycle,
  setRunStatus,
  settleApifyRun,
  unfinishedRuns,
  upsertCompany,
  withTransaction,
} from "@bs/db";
import { type ApifyClient, INDEED_ACTOR, INDEED_PRICES, TERMINAL, indeedInput, mapIndeedItem, runCostUsd } from "@bs/integrations";

export interface Settings {
  apifyCycleCapUsd: number;
}

export type Send = (queue: QueueName, data: object, opts?: { startAfter?: number; singletonKey?: string }) => Promise<unknown>;

export interface Deps {
  pool: pg.Pool;
  apify: Pick<ApifyClient, "startRun" | "getRun" | "datasetItems" | "usage">;
  llm: LlmClient;
  send: Send;
  settings: Settings;
  now: () => Date;
  log: (msg: string, extra?: object) => void;
}

const PAGE = 25; // §5.3a: ≤ 25 dataset items per job
const PLAN = { pricePerItem: INDEED_PRICES["apify-default-dataset-item"], startPrice: INDEED_PRICES["apify-actor-start"] };
const DEFER_SECONDS = 3600; // over cap → try again in an hour (§5.3)

// ── start-board-run ─────────────────────────────────────────────────────────
export async function startBoardRun(d: Deps, job: StartBoardRun): Promise<{ started: string } | { deferred: true }> {
  const usage = await d.apify.usage();
  const plan = { maxItems: job.limit, ...PLAN };
  const worst = worstCaseApifyCost(plan);
  await seedApifyCycle(d.pool, usage.cycleStart, usage.usageUsd, d.settings.apifyCycleCapUsd);
  if (!(await reserveApifyRun(d.pool, usage.cycleStart, worst, d.settings.apifyCycleCapUsd))) {
    d.log("apify cycle cap reached; deferring run", { worst, cap: d.settings.apifyCycleCapUsd });
    await d.send(Q.startBoardRun, job, { startAfter: DEFER_SECONDS });
    return { deferred: true };
  }
  let apifyRunId: string;
  try {
    const run = await d.apify.startRun(INDEED_ACTOR, indeedInput({ ...job, datePosted: "14" }), {
      maxItems: job.limit,
      maxTotalChargeUsd: apifyChargeCap(plan),
    });
    apifyRunId = run.id;
  } catch (e) {
    // Nothing was started: give the reservation back.
    await d.pool.query("update spend_counters set total_usd = greatest(0, total_usd - $2) where key = $1", [apifyCycleKey(usage.cycleStart), worst]);
    throw e;
  }
  await createRun(d.pool, { jobType: "indeed", vertical: job.vertical, country: job.country, apifyRunId, estimatedCostUsd: worst });
  d.log("apify run started", { apifyRunId, title: job.title, country: job.country, worst });
  return { started: apifyRunId };
}

// ── apify-run-event (webhook or poll) ───────────────────────────────────────
export async function onApifyRunEvent(d: Deps, job: ApifyRunEvent): Promise<string> {
  const row = await getRunByApifyId(d.pool, job.apifyRunId);
  if (!row) return "unknown run"; // not started by us — ignore
  if (row.status !== "running") return "already handled";
  const run = await d.apify.getRun(job.apifyRunId);
  if (!TERMINAL.includes(run.status)) return `still ${run.status}`;

  const ok = run.status === "SUCCEEDED";
  if (!(await claimRun(d.pool, row.id, ok ? "fetching" : "failed"))) return "already handled";
  const usage = await d.apify.usage();
  const actual = runCostUsd(run, INDEED_PRICES);
  await withTransaction(d.pool, (c) =>
    settleApifyRun(c, { cycleStart: usage.cycleStart, reservedUsd: Number(row.estimated_cost_usd), actualUsd: actual, runId: row.id, ref: run.id }),
  );
  if (ok) await d.send(Q.fetchDataset, { runId: row.id, datasetId: run.defaultDatasetId, offset: 0 } satisfies FetchDataset);
  d.log("apify run finished", { apifyRunId: run.id, status: run.status, costUsd: actual });
  return run.status;
}

// ── fetch-dataset: freshness → dedup → gate, 25 items per job ───────────────
export async function fetchDataset(d: Deps, job: FetchDataset): Promise<Partial<Record<DropCounter, number>>> {
  const run = (await d.pool.query<{ country: "in" | "ae" | "us"; vertical: string | null }>("select country, vertical from ingestion_runs where id = $1", [job.runId])).rows[0];
  if (!run) throw new Error(`ingestion run ${job.runId} not found`);
  const items = await d.apify.datasetItems(job.datasetId, job.offset, PAGE);
  const counts: Partial<Record<DropCounter, number>> = { raw_items_ingested: items.length };
  const inc = (k: DropCounter) => (counts[k] = (counts[k] ?? 0) + 1);

  for (const raw of items) {
    const post = mapIndeedItem(raw, run.country);
    if (!post) {
      inc("dropped_trie_count");
      continue;
    }
    // The run asked Indeed for 14 days, so it is source-filtered (§4.3).
    if (!checkFreshness(post.postedAt, d.now(), true).fresh) {
      inc("dropped_stale_count");
      continue;
    }
    if (!(await markSeen(d.pool, post.naturalId))) {
      inc("dropped_dedup_count");
      continue;
    }
    const gate = gateJobPost(post);
    if (!gate.pass) {
      inc(gate.reason === "recruiter" ? "dropped_recruiter_count" : "dropped_trie_count");
      continue;
    }
    if (!post.company) {
      inc("dropped_unresolved_count"); // nothing to resolve a website from
      continue;
    }
    await d.send(Q.extractLlm, {
      runId: job.runId,
      vertical: run.vertical as ExtractLlm["vertical"],
      post: { ...post, postedAt: post.postedAt?.toISOString() ?? null },
      founderDependency: gate.founderDependency,
    } satisfies ExtractLlm);
  }
  await bumpCounters(d.pool, job.runId, counts);
  if (items.length === PAGE) await d.send(Q.fetchDataset, { ...job, offset: job.offset + PAGE } satisfies FetchDataset);
  else await setRunStatus(d.pool, job.runId, "done");
  return counts;
}

// ── extract-llm → resolve → size → upsert + score ───────────────────────────
export async function extractLlm(d: Deps, job: ExtractLlm): Promise<string> {
  const post: RawJobPost = { ...job.post, postedAt: job.post.postedAt ? new Date(job.post.postedAt) : null };
  const out = await d.llm.json("extraction", buildJobExtraction({ title: post.title, company: post.company, location: post.city, description: post.description }));
  const si = out.data;

  if (si.automation_fit === "none") return drop(d, job.runId, "dropped_no_fit_count");
  const size = classifySize({ employeeBand: post.boardEmployeeBand, bandSource: "job_board", knownLargeBrand: si.known_large_brand, now: d.now() });
  if (!size.keep) return drop(d, job.runId, "dropped_size_count");

  // Resolve (§5.1 step 5): board website, then cache. The daily search quota arrives in Sprint 2;
  // until then a post with neither is dropped as unresolved.
  const cacheKey = domainCacheKey(post.company!, post.city);
  let domain = bareDomain(post.boardWebsite);
  if (domain) await cacheDomain(d.pool, cacheKey, domain);
  else domain = (await cachedDomain(d.pool, cacheKey)) ?? null;
  if (!domain) return drop(d, job.runId, "dropped_unresolved_count");

  const w = weightsFor("job_post");
  const B = blastRadius(si.blast_radius, job.founderDependency);
  await withTransaction(d.pool, async (c) => {
    const companyId = await upsertCompany(c, {
      domain,
      companyName: post.company,
      vertical: job.vertical,
      country: post.country,
      employeeBand: post.boardEmployeeBand,
      sizeTier: size.tier,
      sizeSource: size.source,
    });
    const inserted = await insertChallenge(c, {
      companyId,
      sourceType: "job_post",
      naturalId: post.naturalId,
      sourceUrl: post.url,
      E: w.E,
      I: w.I,
      B,
      signalScore: signalScore("job_post", w, B),
      department: si.department,
      postedAt: post.postedAt,
      evidenceSnippet: `${post.title}\n\n${post.description}`,
      structuredIntelligence: job.founderDependency ? { ...si, blast_radius: { ...si.blast_radius, founder_dependency_flag: true } } : si,
      llmModel: out.model,
    });
    if (inserted) {
      await recomputeCompanyScore(c, companyId);
      await insertSeedUrl(c, domain!, companyId, "job_post");
      await bumpCounters(c, job.runId, { llm_persisted_count: 1 });
    }
  });
  return `persisted ${domain}`;
}

async function drop(d: Deps, runId: string, counter: DropCounter): Promise<string> {
  await bumpCounters(d.pool, runId, { [counter]: 1 });
  return counter;
}

// ── poll-runs: webhook safety net, and the only path locally (Apify can't reach localhost) ──
export async function pollRuns(d: Deps): Promise<number> {
  const runs = await unfinishedRuns(d.pool, 60);
  for (const r of runs) await d.send(Q.apifyRunEvent, { apifyRunId: r.apify_run_id } satisfies ApifyRunEvent, { singletonKey: r.apify_run_id });
  return runs.length;
}

// ── reconcile-apify: daily, Apify's own usage replaces the counter (§5.3) ───
export async function reconcileApify(d: Deps): Promise<number> {
  const u = await d.apify.usage();
  await reconcileApifyCycle(d.pool, u.cycleStart, u.usageUsd, d.settings.apifyCycleCapUsd);
  return u.usageUsd;
}
