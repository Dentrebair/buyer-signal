// Job handlers for Flow A (PRD §5.1). Each takes its dependencies explicitly so tests can run
// them with fakes; main.ts wires the real ones. Every handler is safe to run twice (§5.3a).
import type pg from "pg";
import {
  type ApifyRunEvent,
  type DomainAge,
  type ExtractLlm,
  type FetchDataset,
  type LlmClient,
  type QueueName,
  type RawJobPost,
  type StartBoardRun,
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
  apify: Pick<ApifyClient, "startRun" | "getRun" | "datasetItems" | "usage">;
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
  const runId = await createRun(d.pool, { jobKey, jobType: "indeed", vertical: job.vertical, country: job.country, estimatedCostUsd: worst });
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
  const usage = await d.apify.usage();
  const actual = runCostUsd(run, INDEED_PRICES);
  // Claim, settle and enqueue the fetch in one transaction: a crash leaves the run 'running'
  // for the next poll, never 'fetching' with no fetch job.
  const claimed = await withTransaction(d.pool, async (c) => {
    if (!(await claimRun(c, row.id, ok ? "fetching" : "failed"))) return false;
    await settleApifyRun(c, { cycleStart: usage.cycleStart, reservedUsd: Number(row.estimated_cost_usd), actualUsd: actual, runId: row.id, ref: run.id });
    if (ok) await d.send(Q.fetchDataset, { runId: row.id, datasetId: run.defaultDatasetId, offset: 0 } satisfies FetchDataset, undefined, c);
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
      const payload: ExtractLlm = {
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

// ── extract-llm → resolve → size → upsert + score ───────────────────────────
export async function extractLlm(d: Deps, job: ExtractLlm): Promise<string> {
  const post = toPost(job);
  const out = await d.llm.json("extraction", buildJobExtraction({ title: post.title, company: post.company, location: post.city, description: post.description }));
  const si = out.data;

  if (si.automation_fit === "none") return drop(d, job.runId, "dropped_no_fit_count");
  const size = classifySize({ employeeBand: post.boardEmployeeBand, bandSource: "job_board", knownLargeBrand: si.known_large_brand, now: d.now() });
  if (!size.keep) return drop(d, job.runId, "dropped_size_count");

  // Resolve (§5.1 step 5): board website (free), then cache. Unknown → the card is made now,
  // marked "No website", and the post joins the search queue; a website found later is attached.
  const cacheKey = domainCacheKey(post.company!, post.city);
  const boardDomain = bareDomain(post.boardWebsite);
  if (boardDomain) await cacheDomain(d.pool, cacheKey, boardDomain);
  const domain = boardDomain ?? (await cachedDomain(d.pool, cacheKey));
  const payload: ResolvePayload = { job, si, model: out.model };
  if (domain === undefined) {
    await enqueueResolve(d.pool, {
      naturalId: post.naturalId,
      runId: job.runId,
      cacheKey,
      company: post.company!,
      city: post.city,
      country: post.country,
      score: provisionalScore(si, job.founderDependency),
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

function provisionalScore(si: StructuredIntelligence, founderDependency: boolean): number {
  return signalScore("job_post", weightsFor("job_post"), blastRadius(si.blast_radius, founderDependency));
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
  const w = weightsFor("job_post");
  const B = blastRadius(si.blast_radius, job.founderDependency);
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
      llmModel: x.model,
    });
    // Always: a website attached later can fold another card's challenges into this company.
    await recomputeCompanyScore(c, companyId);
    if (domain) await insertSeedUrl(c, domain, companyId, "job_post");
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
  for (const r of runs) await d.send(Q.apifyRunEvent, { apifyRunId: r.apify_run_id } satisfies ApifyRunEvent, { singletonKey: r.apify_run_id });
  return runs.length;
}

// ── reconcile-apify: daily, Apify's own usage replaces the counter (§5.3) ───
export async function reconcileApify(d: Deps): Promise<number> {
  const u = await d.apify.usage();
  await reconcileApifyCycle(d.pool, u.cycleStart, u.usageUsd, d.settings.apifyCycleCapUsd);
  return u.usageUsd;
}
