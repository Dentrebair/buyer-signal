// Job handlers for Flow A (PRD §5.1). Each takes its dependencies explicitly so tests can run
// them with fakes; main.ts wires the real ones. Every handler is safe to run twice (§5.3a).
import type pg from "pg";
import {
  type ApifyRunEvent,
  type DomainAge,
  type FetchDataset,
  type LlmClient,
  type QueueName,
  type RawJobPost,
  type StartBoardRun,
  type StartSocialRun,
  type ExtractLlmInput,
  ExtractLlm,
  type FetchSocial,
  type ExtractSocial,
  type AuthorRelation,
  socialQuery,
  matchAtoms,
  urgencyTier,
  RECHECKS,
  RECHECK_SECONDS,
  SEARCH_ACTOR,
  SEARCH_ACTOR_MIN_CAP,
  SEARCH_PRICES,
  buildSocialExtraction,
  gateSnippet,
  linkedinPost,
  linkedinSearchInput,
  type StructuredIntelligence,
  MAX_SIGNAL_AGE_DAYS,
  Q,
  ResolvePayload,
  type SniffDomain,
  type VerticalSlug,
  type Country,
  websiteSignals,
  acceptResolved,
  homepageCandidates,
  pickHomepage,
  apifyChargeCap,
  apifyCycleKey,
  bareDomain,
  blastRadius,
  buildJobExtraction,
  buildResolve,
  checkFreshness,
  classifySize,
  domainCacheKey,
  gateJobPost,
  type PlannedSlot,
  planRotation,
  signalScore,
  weightsFor,
  worstCaseApifyCost,
} from "@bs/core";
import {
  type DropCounter,
  type SocialOutcome,
  purgeSocialResults,
  recordSocialResult,
  setSocialOutcome,
  bumpCounters,
  claimRotationDay,
  rotationHistory,
  cacheDomain,
  cachedDomain,
  claimRun,
  createRun,
  enqueueResolve,
  expireStaleResolves,
  finishResolve,
  markSearched,
  pendingResolves,
  searchesToday,
  getRunByApifyId,
  getRunByJobKey,
  insertChallenge,
  insertSeedUrl,
  markSeen,
  reconcileApifyCycle,
  recomputeCompanyScore,
  recordApifyRun,
  reserveApifyRun,
  seedApifyCycle,
  setRunStatus,
  claimSeeds,
  finishSeed,
  saveSniff,
  seedTarget,
  storedRegisteredAt,
  settleApifyRun,
  unfinishedRuns,
  upsertCompany,
  withTransaction,
} from "@bs/db";
import { type ApifyClient, type Page, type SniffInput, type SniffResult, INDEED_ACTOR, INDEED_PRICES, TERMINAL, indeedInput, mapIndeedItem, pageText, runCostUsd } from "@bs/integrations";

export interface Settings {
  apifyCycleCapUsd: number;
  rotationEnabled: boolean; // ROTATION_ENABLED: the daily ingest-rotation starts paid runs only when true
  boardSlotsPerDay: number; // BOARD_SLOTS_PER_DAY (§4.1)
  boardPostsPerSlot: number; // BOARD_POSTS_PER_SLOT
  searchDailyCap: number; // SEARCH_DAILY_CAP: paid website searches per UTC day (§5.1 step 5c)
}

// `tx`: enqueue inside that transaction, so the job exists only if the transaction commits.
export type Send = (
  queue: QueueName,
  data: object,
  opts?: { startAfter?: number; singletonKey?: string },
  tx?: pg.PoolClient,
) => Promise<unknown>;

export interface Deps {
  pool: pg.Pool;
  apify: Pick<ApifyClient, "startRun" | "getRun" | "datasetItems" | "datasetItemCount" | "usage">;
  llm: LlmClient;
  fetchPage: (url: string) => Promise<Page | null>;
  rdap: DomainAge;
  sniff: (x: SniffInput) => Promise<SniffResult>;
  send: Send;
  settings: Settings;
  now: () => Date;
  log: (msg: string, extra?: object) => void;
}

const PAGE = 25; // §5.3a: ≤ 25 dataset items per job
const PLAN = { pricePerItem: INDEED_PRICES["apify-default-dataset-item"], startPrice: INDEED_PRICES["apify-actor-start"] };
const DEFER_SECONDS = 3600; // over cap → try again in an hour (§5.3)

// ── ingest-rotation (daily cron) ─────────────────────────────────────────────
// Plans the day's slots (§4.1) and sends one start-board-run per slot in the same transaction
// as the day's claim, so a retried cron job never starts a second set of paid runs.
export async function ingestRotation(d: Deps): Promise<{ planned: PlannedSlot[] } | { skipped: string }> {
  if (!d.settings.rotationEnabled) return { skipped: "ROTATION_ENABLED is off" };
  const now = d.now();
  const plan = planRotation(await rotationHistory(d.pool), d.settings.boardSlotsPerDay, now);
  if (!plan.length) return { skipped: "no slot due" };
  const claimed = await withTransaction(d.pool, async (c) => {
    if (!(await claimRotationDay(c, now.toISOString().slice(0, 10), plan))) return false;
    for (const s of plan)
      await d.send(Q.startBoardRun, { country: s.country, title: s.title, vertical: s.vertical, limit: d.settings.boardPostsPerSlot } satisfies StartBoardRun, undefined, c);
    return true;
  });
  if (!claimed) return { skipped: "already planned today" };
  d.log("rotation planned", { slots: plan });
  return { planned: plan };
}

// ── start-board-run ─────────────────────────────────────────────────────────
// `jobKey` (the pg-boss job id) makes a retry of the same job never start a second paid run.
export async function startBoardRun(
  d: Deps,
  job: StartBoardRun,
  jobKey: string,
): Promise<{ started: string } | { deferred: true } | { skipped: string }> {
  const prior = await getRunByJobKey(d.pool, jobKey);
  if (prior?.apify_run_id) return { started: prior.apify_run_id };
  if (prior) {
    // An earlier attempt crashed between starting Apify and recording it: it may or may not have
    // started, so never start another. The daily reconcile corrects the spend counter.
    await setRunStatus(d.pool, prior.id, "failed");
    d.log("start-board-run: earlier attempt unconfirmed; not starting again", { jobKey });
    return { skipped: "unconfirmed earlier attempt" };
  }

  const usage = await d.apify.usage();
  const plan = { maxItems: job.limit, ...PLAN };
  const worst = worstCaseApifyCost(plan);
  const release = () =>
    d.pool.query("update spend_counters set total_usd = greatest(0, total_usd - $2) where key = $1", [apifyCycleKey(usage.cycleStart), worst]);
  await seedApifyCycle(d.pool, usage.cycleStart, usage.usageUsd, d.settings.apifyCycleCapUsd);
  if (!(await reserveApifyRun(d.pool, usage.cycleStart, worst, d.settings.apifyCycleCapUsd))) {
    d.log("apify cycle cap reached; deferring run", { worst, cap: d.settings.apifyCycleCapUsd });
    await d.send(Q.startBoardRun, job, { startAfter: DEFER_SECONDS });
    return { deferred: true };
  }
  const runId = await createRun(d.pool, { jobKey, jobType: "indeed", vertical: job.vertical, country: job.country, estimatedCostUsd: worst, queryTitle: job.title });
  if (!runId) {
    await release(); // a concurrent attempt owns this key
    return { skipped: "concurrent attempt" };
  }
  let apifyRunId: string;
  try {
    apifyRunId = (await d.apify.startRun(INDEED_ACTOR, indeedInput({ ...job, datePosted: "14" }), { maxItems: job.limit, maxTotalChargeUsd: apifyChargeCap(plan) })).id;
  } catch (e) {
    // Apify refused or was unreachable: nothing started, so undo both and let pg-boss retry.
    await d.pool.query("delete from ingestion_runs where id = $1", [runId]);
    await release();
    throw e;
  }
  await recordApifyRun(d.pool, runId, apifyRunId);
  await d.send(Q.apifyRunEvent, { apifyRunId, recheck: RECHECKS } satisfies ApifyRunEvent, { startAfter: RECHECK_SECONDS });
  d.log("apify run started", { apifyRunId, title: job.title, country: job.country, worst });
  return { started: apifyRunId };
}

// ── apify-run-event (webhook or poll) ───────────────────────────────────────
export async function onApifyRunEvent(d: Deps, job: ApifyRunEvent): Promise<string> {
  const row = await getRunByApifyId(d.pool, job.apifyRunId);
  if (!row) return "unknown run"; // not started by us — ignore
  if (row.status !== "running") return "already handled";
  const run = await d.apify.getRun(job.apifyRunId);
  if (!TERMINAL.includes(run.status)) {
    if ((job.recheck ?? 0) > 0) await d.send(Q.apifyRunEvent, { apifyRunId: job.apifyRunId, recheck: job.recheck! - 1 } satisfies ApifyRunEvent, { startAfter: RECHECK_SECONDS });
    return `still ${run.status}`;
  }

  const ok = run.status === "SUCCEEDED";
  const social = row.job_type === "linkedin";
  const usage = await d.apify.usage();
  // Right after a run ends, chargedEventCounts can still show only the start event; the dataset's
  // item count is final (one item per board post, or per search results page), so the cost is
  // the larger of the two.
  const items = ok ? await d.apify.datasetItemCount(run.defaultDatasetId) : 0;
  // Both counts can still read zero seconds after the run ends (2026-11-06: settled at the start
  // fee only). When the dataset looks empty, look again shortly — at most 3 times, so a genuinely
  // empty run is not held up — before settling.
  const recheck = job.recheck ?? 0;
  if (ok && items === 0 && recheck > 0) {
    await d.send(Q.apifyRunEvent, { apifyRunId: job.apifyRunId, recheck: Math.min(recheck - 1, 3) } satisfies ApifyRunEvent, { startAfter: RECHECK_SECONDS / 2 });
    return "waiting for final counts";
  }
  const actual = social
    ? Math.max(runCostUsd(run, SEARCH_PRICES), ok ? items * SEARCH_PRICES["search-page-scraped"] + SEARCH_PRICES["apify-actor-start"] : 0)
    : Math.max(runCostUsd(run, INDEED_PRICES), ok ? items * PLAN.pricePerItem + PLAN.startPrice : 0);
  // Claim, settle and enqueue the fetch in one transaction: a crash leaves the run 'running'
  // for the next poll, never 'fetching' with no fetch job.
  const claimed = await withTransaction(d.pool, async (c) => {
    if (!(await claimRun(c, row.id, ok ? "fetching" : "failed"))) return false;
    await settleApifyRun(c, { cycleStart: usage.cycleStart, reservedUsd: Number(row.estimated_cost_usd), actualUsd: actual, runId: row.id, ref: run.id });
    if (ok && social) await d.send(Q.fetchSocial, { runId: row.id, datasetId: run.defaultDatasetId } satisfies FetchSocial, undefined, c);
    else if (ok) await d.send(Q.fetchDataset, { runId: row.id, datasetId: run.defaultDatasetId, offset: 0 } satisfies FetchDataset, undefined, c);
    return true;
  });
  if (!claimed) return "already handled";
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
    // Mark seen and enqueue in one transaction: a crash in between must not leave a post
    // marked seen but never extracted (a retry would then drop it as a duplicate).
    const gate = gateJobPost(post, run.vertical as VerticalSlug | null);
    const outcome = await withTransaction(d.pool, async (c): Promise<DropCounter | "sent"> => {
      if (!(await markSeen(c, post.naturalId))) return "dropped_dedup_count";
      if (!gate.pass) return gate.reason === "recruiter" ? "dropped_recruiter_count" : "dropped_trie_count";
      if (!post.company) return "dropped_unresolved_count"; // nothing to resolve a website from
      const payload: ExtractLlmInput = {
        runId: job.runId,
        vertical: run.vertical as ExtractLlm["vertical"],
        post: { ...post, postedAt: post.postedAt?.toISOString() ?? null },
        founderDependency: gate.founderDependency,
      };
      await d.send(Q.extractLlm, payload, undefined, c);
      return "sent";
    });
    if (outcome !== "sent") inc(outcome);
  }
  await bumpCounters(d.pool, job.runId, counts);
  if (items.length === PAGE) await d.send(Q.fetchDataset, { ...job, offset: job.offset + PAGE } satisfies FetchDataset);
  else await setRunStatus(d.pool, job.runId, "done");
  return counts;
}

// ── Social digest: LinkedIn posts via Google search (§4.1a) ─────────────────
// start-social-run mirrors start-board-run: reserve the worst case, record the run before
// starting it, and never start twice for one job key. Completion arrives through poll-runs.
export async function startSocialRun(d: Deps, job: StartSocialRun, jobKey: string): Promise<{ started: string } | { deferred: true } | { skipped: string }> {
  const prior = await getRunByJobKey(d.pool, jobKey);
  if (prior?.apify_run_id) return { started: prior.apify_run_id };
  if (prior) {
    await setRunStatus(d.pool, prior.id, "failed");
    return { skipped: "unconfirmed earlier attempt" };
  }
  // Rotation within the vertical: each run takes the next topics (§4.1a).
  const runIndex = Number(
    (await d.pool.query<{ n: string }>("select count(*) n from ingestion_runs where job_type = 'linkedin' and vertical = $1", [job.vertical])).rows[0]!.n,
  );
  const q = socialQuery(job.vertical, { keyword: job.keyword, runIndex });
  const plan = { maxItems: job.pages, pricePerItem: SEARCH_PRICES["search-page-scraped"], startPrice: SEARCH_PRICES["apify-actor-start"] };
  const worst = worstCaseApifyCost(plan);
  const usage = await d.apify.usage();
  const release = () =>
    d.pool.query("update spend_counters set total_usd = greatest(0, total_usd - $2) where key = $1", [apifyCycleKey(usage.cycleStart), worst]);
  await seedApifyCycle(d.pool, usage.cycleStart, usage.usageUsd, d.settings.apifyCycleCapUsd);
  if (!(await reserveApifyRun(d.pool, usage.cycleStart, worst, d.settings.apifyCycleCapUsd))) {
    await d.send(Q.startSocialRun, job, { startAfter: DEFER_SECONDS });
    return { deferred: true };
  }
  const runId = await createRun(d.pool, { jobKey, jobType: "linkedin", vertical: job.vertical, country: job.country, estimatedCostUsd: worst, queryTitle: q.label });
  if (!runId) {
    await release();
    return { skipped: "concurrent attempt" };
  }
  let apifyRunId: string;
  try {
    apifyRunId = (
      await d.apify.startRun(SEARCH_ACTOR, linkedinSearchInput({ query: q.query, country: job.country, pages: job.pages }), {
        maxItems: job.pages,
        maxTotalChargeUsd: apifyChargeCap(plan, SEARCH_ACTOR_MIN_CAP),
      })
    ).id;
  } catch (e) {
    await d.pool.query("delete from ingestion_runs where id = $1", [runId]);
    await release();
    throw e;
  }
  await recordApifyRun(d.pool, runId, apifyRunId);
  await d.send(Q.apifyRunEvent, { apifyRunId, recheck: RECHECKS } satisfies ApifyRunEvent, { startAfter: RECHECK_SECONDS });
  d.log("social run started", { apifyRunId, vertical: job.vertical, topics: q.label, country: job.country, worst });
  return { started: apifyRunId };
}

interface SearchPage {
  organicResults?: { url?: string; title?: string; description?: string }[];
}

// One dataset item per results page. Each LinkedIn result: freshness from its activity id,
// dedup, then recruiter wording; survivors go to extract-social. Free drops are only counted
// (seen_items already stops a repeat); a post the AI reads gets a social_results row, kept for a
// lead and, for 7 days, for an AI drop so the operator can check its judgement. The work-keyword half of the snippet gate does not
// apply: the query already names the topic, and implied posts rarely use job-ad wording (the
// first topic run, 2026-11-06, lost 8 of 10 results there). The AI judges the meaning instead.
export async function fetchSocial(d: Deps, job: FetchSocial): Promise<Partial<Record<DropCounter, number>>> {
  const run = (await d.pool.query<{ country: "in" | "ae" | "us"; vertical: VerticalSlug | null }>("select country, vertical from ingestion_runs where id = $1", [job.runId]))
    .rows[0];
  if (!run) throw new Error(`ingestion run ${job.runId} not found`);
  const pages = await d.apify.datasetItems<SearchPage>(job.datasetId, 0, 10);
  const results = pages.flatMap((p) => p.organicResults ?? []);
  const counts: Partial<Record<DropCounter, number>> = { raw_items_ingested: results.length };
  const inc = (k: DropCounter) => (counts[k] = (counts[k] ?? 0) + 1);
  for (const r of results) {
    const li = r.url ? linkedinPost(r.url) : null;
    const snippet = (r.description ?? "").trim();
    const base = { runId: job.runId, url: r.url ?? "", snippet, postedAt: li?.postedAt ?? null };
    if (!li) {
      inc("dropped_trie_count"); // not a LinkedIn post (a profile, an article, another site)
      continue;
    }
    if (!checkFreshness(li.postedAt, d.now(), true).fresh) {
      inc("dropped_stale_count");
      continue;
    }
    const text = `${r.title ?? ""}\n${snippet}`.slice(0, 2000);
    const gate = gateSnippet(text, run.vertical);
    const naturalId = `post:linkedin:${li.id}`;
    const outcome = await withTransaction(d.pool, async (c): Promise<DropCounter | "sent"> => {
      if (!(await markSeen(c, naturalId))) return "dropped_dedup_count";
      if (!gate.pass && gate.reason === "recruiter") return "dropped_recruiter_count";
      await recordSocialResult(c, { ...base, outcome: "checking" });
      const payload: ExtractSocial = {
        runId: job.runId,
        country: run.country,
        vertical: run.vertical,
        naturalId,
        url: r.url!,
        text,
        snippet: snippet.slice(0, 2000),
        postedAt: li.postedAt.toISOString(),
        founderDependency: gate.pass && gate.founderDependency,
      };
      await d.send(Q.extractSocial, payload, undefined, c);
      return "sent";
    });
    if (outcome !== "sent") inc(outcome);
  }
  await bumpCounters(d.pool, job.runId, counts);
  await setRunStatus(d.pool, job.runId, "done");
  return counts;
}

// Author check (Q59): only the business's own people showing their own manual work — as a
// complaint (suffering) or in an upbeat post (implied) — with the company named. Then the same
// path as a job post.
const OWN_AUTHORS = new Set(["founder_owner", "employee", "company_page"]);
const KEPT_STANCES = new Set(["suffering", "implied"]);

export async function extractSocial(d: Deps, job: ExtractSocial): Promise<string> {
  const out = await d.llm.json("extraction", buildSocialExtraction({ url: job.url, text: job.text }));
  const si = out.data;
  const verdict = (outcome: SocialOutcome) =>
    setSocialOutcome(d.pool, { runId: job.runId, url: job.url, outcome, authorRelation: si.author_relation, stance: si.stance, symptom: si.verified_symptom });
  if (!si.author_relation || !OWN_AUTHORS.has(si.author_relation) || !si.stance || !KEPT_STANCES.has(si.stance)) {
    await verdict("stance");
    return drop(d, job.runId, "dropped_stance_count");
  }
  if (!si.company_name?.trim()) {
    await verdict("no_company");
    return drop(d, job.runId, "dropped_unresolved_count");
  }
  const { company_name, vertical, ...rest } = si;
  const asPost: ExtractLlm = {
    runId: job.runId,
    vertical: vertical ?? job.vertical,
    founderDependency: job.founderDependency,
    source: "linkedin_post",
    author: si.author_relation as AuthorRelation,
    post: {
      naturalId: job.naturalId,
      url: job.url,
      title: "LinkedIn post", // the result title is the author's name: never stored
      company: company_name.trim(),
      description: job.snippet,
      postedAt: job.postedAt,
      city: null,
      country: job.country,
      boardWebsite: null,
      boardEmployeeBand: null,
    },
  };
  const result = await toCard(d, asPost, rest, out.model);
  await verdict(result === "dropped_no_fit_count" ? "no_fit" : result === "dropped_size_count" ? "too_large" : "card");
  return result;
}

// ── extract-llm → resolve → size → upsert + score ───────────────────────────
export async function extractLlm(d: Deps, input: ExtractLlmInput): Promise<string> {
  const job = ExtractLlm.parse(input); // fills source/author for job posts
  const post = toPost(job);
  const out = await d.llm.json("extraction", buildJobExtraction({ title: post.title, company: post.company, location: post.city, description: post.description }));
  const si = out.data;

  return toCard(d, job, si, out.model);
}

// Shared by job posts and LinkedIn posts once extracted: fit → size → resolve → card.
async function toCard(d: Deps, job: ExtractLlm, si: StructuredIntelligence, model: string): Promise<string> {
  const post = toPost(job);
  if (si.automation_fit === "none") return drop(d, job.runId, "dropped_no_fit_count");
  const size = classifySize({ employeeBand: post.boardEmployeeBand, bandSource: "job_board", knownLargeBrand: si.known_large_brand, now: d.now() });
  if (!size.keep) return drop(d, job.runId, "dropped_size_count");

  // Resolve (§5.1 step 5): board website (free), then cache. Unknown → the card is made now,
  // marked "No website", and the post joins the search queue; a website found later is attached.
  const cacheKey = domainCacheKey(post.company!, post.city);
  const boardDomain = bareDomain(post.boardWebsite);
  if (boardDomain) await cacheDomain(d.pool, cacheKey, boardDomain);
  const domain = boardDomain ?? (await cachedDomain(d.pool, cacheKey));
  const payload: ResolvePayload = { job, si, model };
  if (domain === undefined) {
    await enqueueResolve(d.pool, {
      naturalId: post.naturalId,
      runId: job.runId,
      cacheKey,
      company: post.company!,
      city: post.city,
      country: post.country,
      score: provisionalScore(job, si),
      postedAt: post.postedAt,
      payload,
    });
  }
  await persistCard(d, payload, domain ?? null);
  return domain ? `persisted ${domain}` : domain === null ? "persisted (no website)" : "persisted (no website yet, queued for search)";
}

function toPost(job: ExtractLlm): RawJobPost {
  return { ...job.post, postedAt: job.post.postedAt ? new Date(job.post.postedAt) : null };
}

function provisionalScore(job: ExtractLlm, si: StructuredIntelligence): number {
  return signalScore(job.source, weightsFor(job.source, job.author, si.stance), blastRadius(si.blast_radius, job.founderDependency));
}

// Upsert company + challenge + score + seed in one transaction (§5.1 steps 7–8). Safe to run
// twice: the challenge is keyed on the post, so a retry adds nothing. domain null = no website:
// the company is keyed on its name and gets no website sniff.
async function persistCard(d: Deps, x: ResolvePayload, domain: string | null): Promise<void> {
  const { job, si } = x;
  const post = toPost(job);
  const sizeOf = (domainRegisteredAt: Date | null) =>
    classifySize({ employeeBand: post.boardEmployeeBand, bandSource: "job_board", knownLargeBrand: si.known_large_brand, domainRegisteredAt, now: d.now() });
  let size = sizeOf(null);
  if (!size.keep) throw new Error("persistCard: size is checked before a post gets here"); // same inputs, same result
  // §6.7 step 2: domain age only when the employee count is unknown. It only adds a tag, never drops.
  const registeredAt = domain && size.tier === "unknown" ? await domainAge(d, domain) : null;
  if (registeredAt) size = sizeOf(registeredAt);
  if (!size.keep) throw new Error("persistCard: domain age never drops a company");
  const w = weightsFor(job.source, job.author, si.stance);
  const B = blastRadius(si.blast_radius, job.founderDependency);
  // LinkedIn: the snippet only (§4.1a); its title is the author's name, so it is never stored.
  const evidence = job.source === "linkedin_post" ? post.description : `${post.title}\n\n${post.description}`;
  const tier = urgencyTier({
    sourceType: job.source,
    authorRelation: job.author,
    title: job.source === "job_post" ? post.title : null,
    text: evidence,
    matches: matchAtoms(evidence, job.vertical),
  });
  await withTransaction(d.pool, async (c) => {
    const companyId = await upsertCompany(c, {
      domain,
      nameKey: `${post.country}:${domainCacheKey(post.company!, post.city)}`,
      companyName: post.company,
      vertical: job.vertical,
      country: post.country,
      employeeBand: post.boardEmployeeBand,
      sizeTier: size.tier,
      sizeSource: size.source,
      domainRegisteredAt: registeredAt,
    });
    const inserted = await insertChallenge(c, {
      companyId,
      sourceType: job.source,
      naturalId: post.naturalId,
      sourceUrl: post.url,
      E: w.E,
      I: w.I,
      B,
      signalScore: signalScore(job.source, w, B),
      department: si.department,
      postedAt: post.postedAt,
      evidenceSnippet: evidence,
      structuredIntelligence: job.founderDependency ? { ...si, blast_radius: { ...si.blast_radius, founder_dependency_flag: true } } : si,
      llmModel: x.model,
      authorRelation: job.author,
      urgencyTier: tier,
    });
    // Always: a website attached later can fold another card's challenges into this company.
    await recomputeCompanyScore(c, companyId);
    if (domain) await insertSeedUrl(c, domain, companyId, job.source);
    if (inserted) await bumpCounters(c, job.runId, domain ? { llm_persisted_count: 1 } : { llm_persisted_count: 1, persisted_no_website_count: 1 });
  });
}

// Stored date first, so each domain is asked once. A failed lookup leaves the age unknown.
async function domainAge(d: Deps, domain: string): Promise<Date | null> {
  const stored = await storedRegisteredAt(d.pool, domain);
  if (stored) return stored;
  try {
    return await d.rdap.registeredAt(domain);
  } catch (e) {
    d.log("rdap lookup failed; size stays unknown", { domain, error: (e as Error).message });
    return null;
  }
}

// ── resolve-batch: daily website search, best provisional score first (§5.1 step 5c) ──
// Every queued post already has a "No website" card; this attaches the website when found.
export async function resolveBatch(d: Deps): Promise<{ stale: number; cached: number; searched: number; resolved: number; noWebsite: number }> {
  const now = d.now();
  const stats = { stale: 0, cached: 0, searched: 0, resolved: 0, noWebsite: 0 };
  // §4.3: a post still unsearched at 21 days old is no longer searched (its card stays).
  stats.stale = (await expireStaleResolves(d.pool, now, MAX_SIGNAL_AGE_DAYS)).length;

  let quota = d.settings.searchDailyCap - (await searchesToday(d.pool, now));
  // Read a few more than the quota: rows answered by the cache cost nothing.
  for (const row of await pendingResolves(d.pool, Math.max(quota, 0) + 50)) {
    const payload = ResolvePayload.parse(row.payload);
    let domain = await cachedDomain(d.pool, row.cache_key); // an earlier row may have resolved this company
    if (domain === undefined) {
      if (quota <= 0) continue;
      quota--;
      stats.searched++;
      const out = await d.llm.json("resolve", buildResolve({ company: row.company_name, city: row.city, country: row.country }));
      await markSearched(d.pool, row.natural_id, now);
      domain = acceptResolved(out.data, out.citations ?? []) ?? (await checkHomepages(d, homepageCandidates(out.data, out.citations ?? [], row.company_name), row));
      await cacheDomain(d.pool, row.cache_key, domain); // before the card: a crash here never pays twice
    } else stats.cached++;

    await persistCard(d, payload, domain);
    if (await finishResolve(d.pool, row.natural_id, domain ? "resolved" : "unresolved", now)) {
      if (domain) stats.resolved++;
      else stats.noWebsite++;
    }
  }
  return stats;
}

// Free check for candidates the model was unsure of: the homepage must name the company.
async function checkHomepages(d: Deps, candidates: string[], row: { company_name: string; city: string | null }): Promise<string | null> {
  const pages: { domain: string; text: string }[] = [];
  for (const domain of candidates) {
    const page = await d.fetchPage(`https://${domain}/`);
    if (page) pages.push({ domain, text: pageText(page.html) });
  }
  return pickHomepage(pages, row.company_name, row.city);
}

async function drop(d: Deps, runId: string, counter: DropCounter): Promise<string> {
  await bumpCounters(d.pool, runId, { [counter]: 1 });
  return counter;
}

// ── sniff-seeds: every 10 min, pending seeds → one sniff-domain job each (§4.2) ──
const SNIFF_BATCH = 20;
export async function sniffSeeds(d: Deps): Promise<number> {
  return withTransaction(d.pool, async (c) => {
    const seeds = await claimSeeds(c, SNIFF_BATCH);
    // Same transaction: a job exists only if its claim committed.
    for (const s of seeds) await d.send(Q.sniffDomain, { seedId: s.id } satisfies SniffDomain, { singletonKey: s.id }, c);
    return seeds.length;
  });
}

// ── sniff-domain: fetch + tech stack + 4-Gate, then website challenges (§5.4) ──
export async function sniffDomain(d: Deps, job: SniffDomain): Promise<string> {
  const seed = await seedTarget(d.pool, job.seedId);
  if (!seed) return "seed gone";
  if (!seed.company_id) {
    await finishSeed(d.pool, job.seedId, "failed", "no company");
    return "no company";
  }
  const companyId = seed.company_id;
  const res = await d.sniff({ domain: seed.domain, company: seed.company_name, vertical: seed.vertical as VerticalSlug | null, country: seed.country as Country | null, now: d.now() });
  if (!res.reachable) {
    await withTransaction(d.pool, async (c) => {
      await saveSniff(c, companyId, { reachable: false, audit: { unreachable: res.reason } });
      await finishSeed(c, job.seedId, "unreachable", res.reason);
    });
    return `unreachable ${seed.domain}`;
  }
  const signals = websiteSignals(res.audit, res.tech);
  await withTransaction(d.pool, async (c) => {
    await saveSniff(c, companyId, {
      reachable: true,
      clientRendered: res.audit.clientRendered,
      techStack: res.tech,
      audit: { ...res.audit, pages: res.pages },
      contactEmail: res.audit.contacts.emails[0] ?? null,
      contactWhatsapp: res.audit.contacts.whatsapp[0] ?? null,
      contactSourceUrl: res.audit.contacts.sourceUrl,
    });
    for (const sig of signals) {
      const w = weightsFor(sig.sourceType);
      await insertChallenge(c, {
        companyId,
        sourceType: sig.sourceType,
        naturalId: `site:${seed.domain}:${sig.sourceType}`,
        sourceUrl: res.finalUrl,
        E: w.E,
        I: w.I,
        B: 0, // §7: website signals carry no blast radius
        signalScore: signalScore(sig.sourceType, w, 0),
        department: "Unknown",
        postedAt: d.now(),
        evidenceSnippet: sig.evidence,
        structuredIntelligence: null,
        llmModel: null,
        urgencyTier: "low", // §1.1: website signals are passive structural debt
      });
    }
    await recomputeCompanyScore(c, companyId);
    await finishSeed(c, job.seedId, "done");
  });
  return `sniffed ${seed.domain}: ${res.tech.length} tech, ${signals.map((s) => s.sourceType).join("+") || "no website signal"}`;
}

// ── poll-runs: webhook safety net, and the only path locally (Apify can't reach localhost) ──
export async function pollRuns(d: Deps): Promise<number> {
  const runs = await unfinishedRuns(d.pool, 60);
  for (const r of runs) await d.send(Q.apifyRunEvent, { apifyRunId: r.apify_run_id, recheck: 0 } satisfies ApifyRunEvent, { singletonKey: r.apify_run_id });
  await purgeSocialResults(d.pool);
  return runs.length;
}

// ── reconcile-apify: daily, Apify's own usage replaces the counter (§5.3) ───
export async function reconcileApify(d: Deps): Promise<number> {
  const u = await d.apify.usage();
  await reconcileApifyCycle(d.pool, u.cycleStart, u.usageUsd, d.settings.apifyCycleCapUsd);
  return u.usageUsd;
}
