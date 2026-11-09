// Extraction to a scored card (§5.1 steps 4-8): fit, size, resolve, upsert and score.
import {
  type RawJobPost,
  type ExtractLlmInput,
  ExtractLlm,
  matchAtoms,
  urgencyTier,
  type StructuredIntelligence,
  ResolvePayload,
  bareDomain,
  blastRadius,
  buildJobExtraction,
  buildSeedExtraction,
  classifySize,
  domainCacheKey,
  signalScore,
  weightsFor,
  painTypesOf,
} from "@bs/core";
import {
  bumpCounters,
  cacheDomain,
  cachedDomain,
  enqueueResolve,
  insertChallenge,
  insertSeedUrl,
  recomputeCompanyScore,
  storedRegisteredAt,
  upsertCompany,
  withTransaction,
} from "@bs/db";
import { type Deps, drop } from "./deps.ts";

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
export async function toCard(d: Deps, job: ExtractLlm, si: StructuredIntelligence, model: string): Promise<string> {
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
export async function persistCard(d: Deps, x: ResolvePayload, domain: string | null): Promise<void> {
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
  const matches = matchAtoms(evidence, job.vertical);
  const tier = urgencyTier({
    sourceType: job.source,
    authorRelation: job.author,
    title: job.source === "job_post" ? post.title : null,
    text: evidence,
    matches,
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
      painTypes: painTypesOf(job.source, matches.map((m) => m.category)),
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
