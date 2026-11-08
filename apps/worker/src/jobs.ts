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
  type ExtractLlmInput,
  ExtractLlm,
  type AuthorRelation,
  matchAtoms,
  urgencyTier,
  RECHECKS,
  RECHECK_SECONDS,
  gateSnippet,
  type StructuredIntelligence,
  MAX_SIGNAL_AGE_DAYS,
  Q,
  ResolvePayload,
  type SniffDomain,
  type VerticalSlug,
  type Country,
  websiteSignals,
  homepageCandidates,
  pickHomepage,
  apifyChargeCap,
  apifyCycleKey,
  bareDomain,
  blastRadius,
  buildJobExtraction,
  buildSeedExtraction,
  runCompanyCheck,
  checkFreshness,
  classifySize,
  domainCacheKey,
  gateJobPost,
  type ArmSpec,
  FIXER_TITLES,
  SEARCH_TITLES,
  SOCIAL_TOPICS,
  VERTICAL_MARKETS,
  COUNTRIES,
  isFixerHire,
  planDay,
  seedArms,
  seededRng,
  signalScore,
  weightsFor,
  worstCaseApifyCost,
  type StartLiRun,
  type FetchLiRun,
  type ReadLiPost,
  type CardLiPost,
  type CardLiComment,
  liCommentCardGate,
  type RawArchive,
  type ApprovedAtoms,
  type Mailer,
  alertEmail,
  dailyAlerts,
  AUDIT_PER_DAY,
  SAMPLE_KEEP_DAYS,
  buildLeakCheck,
  sampled,
  trieFor,
  type RawSource,
  RAW_KEEP_DAYS,
  type LiRead,
  LI_ARM_COUNTRY,
  LI_MAX_COMMENTS,
  LI_TOPICS_PER_RUN,
  buildLiCardExtraction,
  liCardGate,
  DRIFT_METRICS,
  type DriftMetric,
  compareDrift,
  LI_POST_ACTOR,
  LI_PRICES,
  buildLiRead,
  liItems,
  liSearchInput,
  mapLiItems,
} from "@bs/core";
import {
  type DropCounter,
  purgeSocialResults,
  bumpCounters,
  claimRotationDay,
  armHistory,
  backfillRunArms,
  linkRunArms,
  retireDeadArms,
  seedSearchArms,
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
  saveCompanyCheck,
  approvedAtoms,
  alertInputs,
  saveAlerts,
  markSampleError,
  pendingSamples,
  purgeDropSamples,
  recordDropSample,
  saveLeakCheck,
  driftCounts,
  saveDriftChecks,
  withTransaction,
  liPostToRead,
  liPostForCard,
  setLiCardOutcome,
  liCommentForCard,
  setLiCommentCardOutcome,
  markLiError,
  purgeLinkedin,
  saveLiItems,
  saveLiRead,
} from "@bs/db";
import { type ApifyClient, type Page, type SniffInput, type SniffResult, INDEED_ACTOR, INDEED_PRICES, TERMINAL, indeedInput, mapIndeedItem, pageText, runCostUsd } from "@bs/integrations";

export interface Settings {
  apifyCycleCapUsd: number;
  rotationEnabled: boolean; // ROTATION_ENABLED: the daily ingest-rotation starts paid runs only when true
  boardSlotsPerDay: number; // BOARD_SLOTS_PER_DAY (§4.1)
  boardPostsPerSlot: number; // BOARD_POSTS_PER_SLOT
  socialSlotsPerDay: number; // SOCIAL_SLOTS_PER_DAY (§4.1c): LinkedIn post searches a day
  liPostsPerTopic: number; // LI_POSTS_PER_TOPIC (§4.1d)
  liCommentsPerPost: number; // LI_COMMENTS_PER_POST
  searchDailyCap: number; // SEARCH_DAILY_CAP: paid website searches per UTC day (§5.1 step 5c)
  healthUrl: string; // HEALTH_URL: the link in the alert email
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
  archive: RawArchive;
  mailer: Mailer | null; // null until RESEND_API_KEY and ALERT_EMAIL_TO are set: alerts stay on /health
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
export async function ingestRotation(d: Deps): Promise<{ planned: { job: object[]; social: object[] } } | { skipped: string }> {
  if (!d.settings.rotationEnabled) return { skipped: "ROTATION_ENABLED is off" };
  const now = d.now();
  const day = now.toISOString().slice(0, 10);
  await syncSearchArms(d);
  const { arms, runs } = await armHistory(d.pool);
  const plan = planDay(arms, runs, { job: d.settings.boardSlotsPerDay, social: d.settings.socialSlotsPerDay, topicsPerSocial: LI_TOPICS_PER_RUN }, seededRng(day), now);
  const job = plan.job.map((a) => ({ country: a.country as Country, title: a.term, vertical: a.vertical as VerticalSlug | null, limit: d.settings.boardPostsPerSlot }));
  // Social topics run as LinkedIn post search (§4.1d).
  const social = plan.social.map((s) => ({
    vertical: s.vertical as VerticalSlug,
    topics: s.topics.map((t) => t.term),
    posts: d.settings.liPostsPerTopic,
    comments: d.settings.liCommentsPerPost,
  }));
  if (!job.length && !social.length) return { skipped: "no search to run" };
  const claimed = await withTransaction(d.pool, async (c) => {
    if (!(await claimRotationDay(c, day, [...job, ...social]))) return false;
    for (const j of job) await d.send(Q.startBoardRun, j satisfies StartBoardRun, undefined, c);
    for (const s of social) await d.send(Q.startLiRun, s satisfies StartLiRun, undefined, c);
    return true;
  });
  if (!claimed) return { skipped: "already planned today" };
  d.log("rotation planned", { job, social });
  return { planned: { job, social } };
}

// The arms the code knows, runs from before the bandit, and retirements (5 runs, 0 cards).
const jobArm = (vertical: VerticalSlug | null, country: string, term: string): ArmSpec => ({
  kind: "job",
  vertical,
  country,
  term,
  group: vertical === null || isFixerHire(term) ? "high" : "low",
});
export async function syncSearchArms(d: Pick<Deps, "pool">): Promise<{ added: number; linked: number; retired: number }> {
  const added = await seedSearchArms(
    d.pool,
    seedArms({ markets: VERTICAL_MARKETS, titles: SEARCH_TITLES, fixerTitles: FIXER_TITLES, countries: Object.keys(COUNTRIES), topics: SOCIAL_TOPICS, topicCountry: LI_ARM_COUNTRY }),
  );
  const linked = await backfillRunArms(d.pool, (kind, term) => (kind === "social" ? "medium" : isFixerHire(term) ? "high" : "low"));
  const retired = await retireDeadArms(d.pool);
  return { added, linked, retired };
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
  await linkRunArms(d.pool, runId, [jobArm(job.vertical, job.country, job.title)]);
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
  const li = row.job_type === "li_posts";
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
  const actual = li
    ? Math.max(runCostUsd(run, LI_PRICES), ok ? items * LI_PRICES.post + LI_PRICES["apify-actor-start"] : 0) // a comment costs what a post does
    : Math.max(runCostUsd(run, INDEED_PRICES), ok ? items * PLAN.pricePerItem + PLAN.startPrice : 0);
  // Claim, settle and enqueue the fetch in one transaction: a crash leaves the run 'running'
  // for the next poll, never 'fetching' with no fetch job.
  const claimed = await withTransaction(d.pool, async (c) => {
    if (!(await claimRun(c, row.id, ok ? "fetching" : "failed"))) return false;
    await settleApifyRun(c, { cycleStart: usage.cycleStart, reservedUsd: Number(row.estimated_cost_usd), actualUsd: actual, runId: row.id, ref: run.id });
    if (ok && li) await d.send(Q.fetchLiRun, { runId: row.id, datasetId: run.defaultDatasetId } satisfies FetchLiRun, undefined, c);
    else if (ok && row.job_type === "indeed") await d.send(Q.fetchDataset, { runId: row.id, datasetId: run.defaultDatasetId, offset: 0 } satisfies FetchDataset, undefined, c);
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
  await archiveRaw(d, "indeed", job.runId, String(job.offset), items);
  const approved = await approvedAtomsCached(d);
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
    const gate = gateJobPost(post, run.vertical as VerticalSlug | null, trieFor(run.vertical as VerticalSlug | null, approved));
    const outcome = await withTransaction(d.pool, async (c): Promise<DropCounter | "sent"> => {
      if (!(await markSeen(c, post.naturalId))) return "dropped_dedup_count";
      if (!gate.pass && gate.reason === "recruiter") return "dropped_recruiter_count";
      if (!gate.pass) {
        // Leak check (§6.3 step 6): a fixed 2 % of the trie's drops is kept for the AI to read.
        if (sampled(post.naturalId))
          await recordDropSample(c, { runId: job.runId, naturalId: post.naturalId, vertical: run.vertical, country: run.country, title: post.title, text: post.description });
        return "dropped_trie_count";
      }
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

// ── LinkedIn post search (§4.1d) ────────────────────────────────────────────
// start-li-run mirrors start-board-run: reserve the worst case (every post and comment slot
// filled), record the run and link it to its topic arms, never start twice for one job key.
export async function startLiRun(d: Deps, job: StartLiRun, jobKey: string): Promise<{ started: string } | { deferred: true } | { skipped: string }> {
  const prior = await getRunByJobKey(d.pool, jobKey);
  if (prior?.apify_run_id) return { started: prior.apify_run_id };
  if (prior) {
    await setRunStatus(d.pool, prior.id, "failed");
    return { skipped: "unconfirmed earlier attempt" };
  }
  const plan = { maxItems: liItems({ ...job, topics: job.topics.length }), pricePerItem: LI_PRICES.post, startPrice: LI_PRICES["apify-actor-start"] };
  const worst = worstCaseApifyCost(plan);
  const usage = await d.apify.usage();
  const release = () =>
    d.pool.query("update spend_counters set total_usd = greatest(0, total_usd - $2) where key = $1", [apifyCycleKey(usage.cycleStart), worst]);
  await seedApifyCycle(d.pool, usage.cycleStart, usage.usageUsd, d.settings.apifyCycleCapUsd);
  if (!(await reserveApifyRun(d.pool, usage.cycleStart, worst, d.settings.apifyCycleCapUsd))) {
    await d.send(Q.startLiRun, job, { startAfter: DEFER_SECONDS });
    return { deferred: true };
  }
  const runId = await createRun(d.pool, { jobKey, jobType: "li_posts", vertical: job.vertical, country: null, estimatedCostUsd: worst, queryTitle: job.topics.join(", ") });
  if (!runId) {
    await release();
    return { skipped: "concurrent attempt" };
  }
  // The bandit learns from every run, rotation or Run now: one Medium topic arm per topic.
  await linkRunArms(
    d.pool,
    runId,
    job.topics.map((term) => ({ kind: "social" as const, vertical: job.vertical, country: LI_ARM_COUNTRY, term, group: "medium" as const })),
  );
  let apifyRunId: string;
  try {
    const input = liSearchInput({ topics: job.topics, posts: job.posts, comments: job.comments });
    apifyRunId = (await d.apify.startRun(LI_POST_ACTOR, input, { maxItems: plan.maxItems, maxTotalChargeUsd: apifyChargeCap(plan) })).id;
  } catch (e) {
    await d.pool.query("delete from ingestion_runs where id = $1", [runId]);
    await release();
    throw e;
  }
  await recordApifyRun(d.pool, runId, apifyRunId);
  await d.send(Q.apifyRunEvent, { apifyRunId, recheck: RECHECKS } satisfies ApifyRunEvent, { startAfter: RECHECK_SECONDS });
  d.log("linkedin search started", { apifyRunId, topics: job.topics, posts: job.posts, comments: job.comments, worst });
  return { started: apifyRunId };
}

const LI_PAGE = 200;
const LI_MAX_ITEMS = 2000;

// Posts and comments arrive as separate items. Posts older than 21 days are dropped (§4.3; the
// actor's nearest window is a month); the rest are saved with their comments and each gets a read.
export async function fetchLiRun(d: Deps, job: FetchLiRun): Promise<Partial<Record<DropCounter, number>>> {
  const items: unknown[] = [];
  for (let offset = 0; offset < LI_MAX_ITEMS; offset += LI_PAGE) {
    const page = await d.apify.datasetItems<unknown>(job.datasetId, offset, LI_PAGE);
    items.push(...page);
    if (page.length < LI_PAGE) break;
  }
  await archiveRaw(d, "li_posts", job.runId, "all", items);
  const { posts, comments, skipped } = mapLiItems(items);
  const fresh = posts.filter((p) => checkFreshness(p.postedAt, d.now(), true).fresh);
  const counts: Partial<Record<DropCounter, number>> = {
    raw_items_ingested: posts.length,
    dropped_stale_count: posts.length - fresh.length,
    dropped_trie_count: skipped,
  };
  await withTransaction(d.pool, async (c) => {
    const ids = await saveLiItems(c, job.runId, fresh, comments);
    for (const liPostId of ids) await d.send(Q.readLiPost, { liPostId } satisfies ReadLiPost, undefined, c);
  });
  await bumpCounters(d.pool, job.runId, counts);
  await setRunStatus(d.pool, job.runId, "done");
  return counts;
}

// One AI call per post, with its comments: the pains, who wrote it, their company and market, and
// for each comment whether it shares the pain and what is critical in it. A post that passes the
// card gate (liCardGate) goes on to card-li-post.
export async function readLiPost(d: Deps, job: ReadLiPost): Promise<string> {
  const post = await liPostToRead(d.pool, job.liPostId, LI_MAX_COMMENTS);
  if (!post) return "post gone";
  if (post.status !== "reading") return "already read";
  const req = buildLiRead(
    { text: post.body, authorHeadline: post.authorHeadline, authorType: post.authorType },
    post.comments.map((c) => ({ text: c.body, headline: c.headline, actorType: c.actorType })),
  );
  const out = await d.llm.json("extraction", req).catch(async (e: unknown) => {
    // Invalid output after the client's retry is final: stop showing it as being read.
    if ((e as { retryable?: unknown }).retryable === false) await markLiError(d.pool, post.id);
    throw e;
  });
  const gate = liCardGate(out.data);
  await withTransaction(d.pool, async (c) => {
    const commenters = await saveLiRead(c, post.id, out.data, post.comments, gate.ok ? "checking" : gate.outcome);
    if (gate.ok) await d.send(Q.cardLiPost, { liPostId: post.id } satisfies CardLiPost, undefined, c);
    for (const liCommentId of commenters) await d.send(Q.cardLiComment, { liCommentId } satisfies CardLiComment, undefined, c);
  });
  const shared = out.data.comments.filter((k) => k.resonates).length;
  return out.data.has_pain ? `pain: ${out.data.pains.length}, ${shared} comments share it, card: ${gate.ok ? "checking" : gate.outcome}` : "no pain";
}

// A kept pain post becomes a card on the same path as a job post (fit → size → resolve → card).
// The read's author check stands; this call only fills the card. A post already carded (found
// by another topic, or by the Google digest before it) costs no second call.
export async function cardLiPost(d: Deps, job: CardLiPost): Promise<string> {
  const p = await liPostForCard(d.pool, job.liPostId);
  if (!p) return "post gone";
  if (p.cardOutcome !== "checking") return "already decided";
  const gate = liCardGate({
    has_pain: !!p.hasPain,
    author_relation: p.authorRelation as LiRead["author_relation"],
    stance: p.stance as LiRead["stance"],
    author_company: p.authorCompany,
    author_country: (p.authorCountry ?? "unknown") as LiRead["author_country"],
  });
  if (!gate.ok) {
    await setLiCardOutcome(d.pool, p.id, gate.outcome);
    return gate.outcome;
  }
  const naturalId = `post:linkedin:${p.postId}`;
  if ((await d.pool.query("select 1 from challenges where natural_id = $1", [naturalId])).rowCount) {
    await setLiCardOutcome(d.pool, p.id, "duplicate");
    return "duplicate";
  }
  const req = buildLiCardExtraction({ text: p.body, authorHeadline: p.authorHeadline, company: gate.company, authorRelation: p.authorRelation!, stance: p.stance! });
  const out = await d.llm.json("extraction", req).catch(async (e: unknown) => {
    if ((e as { retryable?: unknown }).retryable === false) await setLiCardOutcome(d.pool, p.id, "ai_error");
    throw e;
  });
  const { vertical, ...extracted } = out.data;
  // The read's verdict on the author wins over the card call's copy of it.
  const si: StructuredIntelligence = { ...extracted, author_relation: p.authorRelation as AuthorRelation, stance: p.stance as StructuredIntelligence["stance"] };
  // Solved with software: they have tools but nothing joining them up, so pitch Company OS (§1.1).
  const rest = si.stance === "solved" && si.solved_how === "with_software" ? { ...si, product_layer: "company_os" as const } : si;
  const text = p.body.slice(0, 2000);
  const gated = gateSnippet(text, (vertical ?? p.vertical) as VerticalSlug | null);
  const asPost: ExtractLlm = {
    runId: p.runId,
    vertical: (vertical ?? p.vertical) as VerticalSlug | null,
    founderDependency: gated.pass && gated.founderDependency,
    source: "linkedin_post",
    author: p.authorRelation as AuthorRelation,
    post: {
      naturalId,
      url: p.url,
      title: "LinkedIn post",
      company: gate.company,
      description: text,
      postedAt: p.postedAt ? p.postedAt.toISOString() : null,
      city: null,
      country: gate.country,
      boardWebsite: null,
      boardEmployeeBand: null,
    },
  };
  const result = await toCard(d, asPost, rest, out.model);
  await setLiCardOutcome(d.pool, p.id, result === "dropped_no_fit_count" ? "no_fit" : result === "dropped_size_count" ? "too_large" : "card");
  return result;
}

// A commenter's own card (operator's choice, 2026-11-08: green or yellow comments). The comment
// is the evidence and the post is context; shares counts as suffering, another perspective as
// implied (lower intent). Same path to a card as a post.
const REPLY_STANCE = { shares: "suffering", perspective: "implied" } as const;

export async function cardLiComment(d: Deps, job: CardLiComment): Promise<string> {
  const k = await liCommentForCard(d.pool, job.liCommentId);
  if (!k) return "comment gone";
  if (k.cardOutcome !== "checking") return "already decided";
  const gate = liCommentCardGate({
    reply_kind: k.replyKind ?? "unhelpful",
    relation: k.relation as LiRead["author_relation"],
    company: k.company,
    country: (k.country ?? "unknown") as LiRead["author_country"],
  });
  if (!gate.ok) {
    await setLiCommentCardOutcome(d.pool, k.id, gate.outcome);
    return gate.outcome;
  }
  const naturalId = `comment:linkedin:${k.commentId}`;
  if ((await d.pool.query("select 1 from challenges where natural_id = $1", [naturalId])).rowCount) {
    await setLiCommentCardOutcome(d.pool, k.id, "duplicate");
    return "duplicate";
  }
  const stance = REPLY_STANCE[k.replyKind === "shares" ? "shares" : "perspective"]; // the gate let only these two through
  const req = buildLiCardExtraction({ text: k.body, authorHeadline: k.headline, company: gate.company, authorRelation: k.relation!, stance, replyTo: k.postBody });
  const out = await d.llm.json("extraction", req).catch(async (e: unknown) => {
    if ((e as { retryable?: unknown }).retryable === false) await setLiCommentCardOutcome(d.pool, k.id, "ai_error");
    throw e;
  });
  const { vertical, ...extracted } = out.data;
  const si: StructuredIntelligence = { ...extracted, author_relation: k.relation as AuthorRelation, stance };
  const rest = si.stance === "solved" && si.solved_how === "with_software" ? { ...si, product_layer: "company_os" as const } : si;
  const text = k.body.slice(0, 2000);
  const gated = gateSnippet(text, (vertical ?? k.vertical) as VerticalSlug | null);
  const asPost: ExtractLlm = {
    runId: k.runId,
    vertical: (vertical ?? k.vertical) as VerticalSlug | null,
    founderDependency: gated.pass && gated.founderDependency,
    source: "linkedin_post",
    author: k.relation as AuthorRelation,
    post: {
      naturalId,
      url: k.url ?? k.postUrl,
      title: "LinkedIn comment",
      company: gate.company,
      description: text,
      postedAt: (k.commentedAt ?? k.postedAt)?.toISOString() ?? null,
      city: null,
      country: gate.country,
      boardWebsite: null,
      boardEmployeeBand: null,
    },
  };
  const result = await toCard(d, asPost, rest, out.model);
  await setLiCommentCardOutcome(d.pool, k.id, result === "dropped_no_fit_count" ? "no_fit" : result === "dropped_size_count" ? "too_large" : "card");
  return result;
}

// ── extract-llm → resolve → size → upsert + score ───────────────────────────
export async function extractLlm(d: Deps, input: ExtractLlmInput): Promise<string> {
  const job = ExtractLlm.parse(input); // fills source/author for job posts
  const post = toPost(job);
  const ep = { title: post.title, company: post.company, location: post.city, description: post.description };
  // A run with no vertical (fixer hires, §1.1) asks the AI for it, as the Sprint 0 seed did.
  if (job.vertical === null) {
    const out = await d.llm.json("extraction", buildSeedExtraction(ep));
    const { vertical, ...si } = out.data;
    return toCard(d, { ...job, vertical }, si, out.model);
  }
  const out = await d.llm.json("extraction", buildJobExtraction(ep));
  return toCard(d, job, out.data, out.model);
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
  return signalScore(job.source, weightsFor(job.source, job.author, si.stance, si.solved_how), blastRadius(si.blast_radius, job.founderDependency));
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
  const w = weightsFor(job.source, job.author, si.stance, si.solved_how);
  const B = blastRadius(si.blast_radius, job.founderDependency);
  // LinkedIn: the post text only (§4.1d); its title is a placeholder, never the author's name.
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
      runId: job.runId,
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
      // §5.1a: the company-check agent searches, opens pages and judges the company.
      const check = await runCompanyCheck(
        { company: row.company_name, city: row.city, country: row.country, vertical: payload.job.vertical },
        {
          llm: d.llm,
          fetchText: async (url) => {
            const page = await d.fetchPage(url);
            return page ? { url: page.url, text: pageText(page.html) } : null;
          },
        },
      );
      await markSearched(d.pool, row.natural_id, now);
      domain = check.domain ?? (await checkHomepages(d, homepageCandidates(check.lastPick, check.citations, row.company_name), row));
      await cacheDomain(d.pool, row.cache_key, domain); // before the card: a crash here never pays twice
      await persistCard(d, payload, domain);
      const { citations: _c, lastPick: _p, ...found } = check;
      await saveCompanyCheck(d.pool, { domain, nameKey: `${row.country}:${row.cache_key}` }, { ...found, domain, checkedAt: now.toISOString() });
    } else {
      stats.cached++;
      await persistCard(d, payload, domain);
    }

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

// ── audit-dropped: daily leak check (§6.3 step 6) ────────────────────────────
// Phrases the operator approved join the trie; read at most once a minute.
const APPROVED_TTL_MS = 60_000;
let approvedCache: { at: number; value: ApprovedAtoms } | null = null;
async function approvedAtomsCached(d: Pick<Deps, "pool">): Promise<ApprovedAtoms> {
  if (approvedCache && Date.now() - approvedCache.at < APPROVED_TTL_MS) return approvedCache.value;
  approvedCache = { at: Date.now(), value: await approvedAtoms(d.pool) };
  return approvedCache.value;
}

export async function auditDropped(d: Pick<Deps, "pool" | "llm" | "log">, idPrefix = ""): Promise<{ checked: number; leads: number; phrases: number }> {
  const out = { checked: 0, leads: 0, phrases: 0 };
  for (const s of await pendingSamples(d.pool, AUDIT_PER_DAY, idPrefix)) {
    let read;
    try {
      read = await d.llm.json("extraction", buildLeakCheck({ title: s.title, text: s.text }));
    } catch (e) {
      if ((e as { retryable?: unknown }).retryable === false) {
        await markSampleError(d.pool, s.id);
        continue;
      }
      throw e; // a provider outage: the job retries, and checked samples stay checked
    }
    out.phrases += await withTransaction(d.pool, (c) => saveLeakCheck(c, s, read.data));
    out.checked++;
    if (read.data.is_lead) out.leads++;
  }
  if (out.leads) d.log("leak check: dropped posts that were leads", out);
  return out;
}

// ── daily-alerts (Q65) ──────────────────────────────────────────────────────
// After the night's jobs: what needs the operator is saved (shown on /health) and, when a mailer
// is set up, emailed once. A failed email is logged; the alerts stay saved.
export async function dailyAlertsJob(d: Pick<Deps, "pool" | "mailer" | "settings" | "now" | "log">): Promise<{ alerts: number; emailed: boolean }> {
  const day = d.now().toISOString().slice(0, 10);
  const alerts = dailyAlerts(await alertInputs(d.pool, d.settings.rotationEnabled));
  if (!alerts.length) return { alerts: 0, emailed: false };
  let emailed = false;
  if (d.mailer) {
    try {
      await d.mailer.send(alertEmail(alerts, day, d.settings.healthUrl));
      emailed = true;
    } catch (e) {
      d.log("alert email failed; alerts saved", { error: (e as Error).message });
    }
  }
  await saveAlerts(d.pool, day, alerts, emailed);
  d.log("daily alerts", { alerts: alerts.map((a) => a.kind), emailed });
  return { alerts: alerts.length, emailed };
}

// ── Raw payload archive (Q64) ───────────────────────────────────────────────
// A convenience for re-runs, never a reason to lose a run: a failed upload is logged and the
// fetch carries on.
async function archiveRaw(d: Deps, source: RawSource, runId: string, part: string, items: unknown[]): Promise<void> {
  if (!items.length) return;
  try {
    await d.archive.put({ source, day: d.now().toISOString().slice(0, 10), runId, part, items });
  } catch (e) {
    d.log("raw archive failed; run continues", { source, runId, part, error: (e as Error).message });
  }
}

// Daily: raw archives older than 21 days are deleted (§18.9), and so are leak-check samples.
export async function purgeRaw(d: Pick<Deps, "archive" | "now" | "pool">): Promise<{ files: number; samples: number }> {
  return { files: await d.archive.purge(RAW_KEEP_DAYS, d.now()), samples: await purgeDropSamples(d.pool, SAMPLE_KEEP_DAYS) };
}

// ── poll-runs: webhook safety net, and the only path locally (Apify can't reach localhost) ──
export async function pollRuns(d: Deps): Promise<number> {
  const runs = await unfinishedRuns(d.pool, 60);
  for (const r of runs) await d.send(Q.apifyRunEvent, { apifyRunId: r.apify_run_id, recheck: 0 } satisfies ApifyRunEvent, { singletonKey: r.apify_run_id });
  await purgeSocialResults(d.pool);
  await purgeLinkedin(d.pool);
  return runs.length;
}

// ── reconcile-apify: daily, Apify's own usage replaces the counter (§5.3) ───
export async function reconcileApify(d: Deps): Promise<number> {
  const u = await d.apify.usage();
  await reconcileApifyCycle(d.pool, u.cycleStart, u.usageUsd, d.settings.apifyCycleCapUsd);
  return u.usageUsd;
}

// ── drift-check: daily, free (SQL only) ─────────────────────────────────────
// The last 7 days of each health number against the 14 before; the inbox shows what moved.
export async function driftCheck(d: Pick<Deps, "pool" | "now" | "log">): Promise<{ moved: string[] }> {
  const now = d.now();
  const counts = await driftCounts(d.pool, now);
  const results = (Object.keys(DRIFT_METRICS) as DriftMetric[]).map((m) => compareDrift(m, counts[m].w, counts[m].b));
  await saveDriftChecks(d.pool, now.toISOString().slice(0, 10), results);
  const moved = results.filter((r) => r.verdict === "moved").map((r) => `${r.metric} ${r.direction}`);
  if (moved.length) d.log("drift: numbers moved", { moved });
  return { moved };
}
