// Paid Apify runs: the daily rotation, starting runs, their completion events, the poll safety net and the daily reconcile.
import {
  type ApifyRunEvent,
  type FetchDataset,
  type StartBoardRun,
  RECHECKS,
  RECHECK_SECONDS,
  Q,
  type VerticalSlug,
  type Country,
  apifyChargeCap,
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
  worstCaseApifyCost,
  type StartLiRun,
  type FetchLiRun,
  LI_ARM_COUNTRY,
  LI_TOPICS_PER_RUN,
  LI_PRICES,
  type QueueName,
  type ApifyRunPlan,
} from "@bs/core";
import {
  purgeSocialResults,
  claimRotationDay,
  armHistory,
  backfillRunArms,
  linkRunArms,
  retireDeadArms,
  seedSearchArms,
  claimRun,
  createRun,
  getRunByApifyId,
  getRunByJobKey,
  reconcileApifyCycle,
  recordApifyRun,
  reserveApifyRun,
  seedApifyCycle,
  setRunStatus,
  settleApifyRun,
  unfinishedRuns,
  expireContactSearches,
  expireRoasts,
  expireDraftRequests,
  withTransaction,
  purgeLinkedin,
  releaseApifyReservation,
  deleteRun,
} from "@bs/db";
import {
  INDEED_ACTOR,
  INDEED_PRICES,
  TERMINAL,
  indeedInput,
  runCostUsd,
} from "@bs/integrations";
import { fetchDataset } from "./boards.ts";
import { type Deps, DEFER_SECONDS, PLAN } from "./deps.ts";
import { fetchLiRun, startLiRun } from "./linkedin.ts";

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

// ── Starting a paid run ─────────────────────────────────────────────────────
// Every paid Apify run starts the same way, so a retry never pays twice and the cap always holds:
// an earlier attempt with this job key wins (`jobKey` is the pg-boss job id); the worst case is
// reserved against the cycle cap, or the job waits an hour; the run is recorded and linked to its
// searches before Apify is asked; if Apify refuses, both are undone and pg-boss retries; then
// completion is checked from 20 s on, not at the next 5-minute poll.
export async function startPaidRun(
  d: Deps,
  x: {
    jobKey: string;
    retry: { queue: QueueName; job: object };
    plan: ApifyRunPlan;
    run: { jobType: string; vertical: string | null; country: string | null; queryTitle: string };
    arms: ArmSpec[];
    actor: string;
    input: object;
    log: { msg: string; extra: object };
  },
): Promise<{ started: string } | { deferred: true } | { skipped: string }> {
  const prior = await getRunByJobKey(d.pool, x.jobKey);
  if (prior?.apify_run_id) return { started: prior.apify_run_id };
  if (prior) {
    // An earlier attempt crashed between starting Apify and recording it: it may or may not have
    // started, so never start another. The daily reconcile corrects the spend counter.
    await setRunStatus(d.pool, prior.id, "failed");
    d.log("earlier start unconfirmed; not starting again", { jobKey: x.jobKey, jobType: x.run.jobType });
    return { skipped: "unconfirmed earlier attempt" };
  }
  const worst = worstCaseApifyCost(x.plan);
  const usage = await d.apify.usage();
  await seedApifyCycle(d.pool, usage.cycleStart, usage.usageUsd, d.settings.apifyCycleCapUsd);
  if (!(await reserveApifyRun(d.pool, usage.cycleStart, worst, d.settings.apifyCycleCapUsd))) {
    d.log("apify cycle cap reached; deferring run", { worst, cap: d.settings.apifyCycleCapUsd, jobType: x.run.jobType });
    await d.send(x.retry.queue, x.retry.job, { startAfter: DEFER_SECONDS });
    return { deferred: true };
  }
  const runId = await createRun(d.pool, { jobKey: x.jobKey, ...x.run, estimatedCostUsd: worst });
  if (!runId) {
    await releaseApifyReservation(d.pool, usage.cycleStart, worst); // a concurrent attempt owns this key
    return { skipped: "concurrent attempt" };
  }
  await linkRunArms(d.pool, runId, x.arms);
  let apifyRunId: string;
  try {
    apifyRunId = (await d.apify.startRun(x.actor, x.input, { maxItems: x.plan.maxItems, maxTotalChargeUsd: apifyChargeCap(x.plan) })).id;
  } catch (e) {
    await deleteRun(d.pool, runId);
    await releaseApifyReservation(d.pool, usage.cycleStart, worst);
    throw e;
  }
  await recordApifyRun(d.pool, runId, apifyRunId);
  await d.send(Q.apifyRunEvent, { apifyRunId, recheck: RECHECKS } satisfies ApifyRunEvent, { startAfter: RECHECK_SECONDS });
  d.log(x.log.msg, { apifyRunId, worst, ...x.log.extra });
  return { started: apifyRunId };
}

// ── start-board-run ─────────────────────────────────────────────────────────
export function startBoardRun(d: Deps, job: StartBoardRun, jobKey: string): ReturnType<typeof startPaidRun> {
  return startPaidRun(d, {
    jobKey,
    retry: { queue: Q.startBoardRun, job },
    plan: { maxItems: job.limit, ...PLAN },
    run: { jobType: "indeed", vertical: job.vertical, country: job.country, queryTitle: job.title },
    arms: [jobArm(job.vertical, job.country, job.title)],
    actor: INDEED_ACTOR,
    input: indeedInput({ ...job, datePosted: "14" }),
    log: { msg: "apify run started", extra: { title: job.title, country: job.country } },
  });
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

// ── poll-runs: webhook safety net, and the only path locally (Apify can't reach localhost) ──
export async function pollRuns(d: Deps): Promise<number> {
  const runs = await unfinishedRuns(d.pool, 60);
  for (const r of runs) await d.send(Q.apifyRunEvent, { apifyRunId: r.apify_run_id, recheck: 0 } satisfies ApifyRunEvent, { singletonKey: r.apify_run_id });
  await purgeSocialResults(d.pool);
  await purgeLinkedin(d.pool);
  await expireDraftRequests(d.pool);
  await expireContactSearches(d.pool);
  await expireRoasts(d.pool);
  return runs.length;
}

// ── reconcile-apify: daily, Apify's own usage replaces the counter (§5.3) ───
export async function reconcileApify(d: Deps): Promise<number> {
  const u = await d.apify.usage();
  await reconcileApifyCycle(d.pool, u.cycleStart, u.usageUsd, d.settings.apifyCycleCapUsd);
  return u.usageUsd;
}
