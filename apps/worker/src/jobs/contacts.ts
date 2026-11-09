// Contact search on the operator's click (/contacts, migration 0028).
import {
  type ContactSearch,
  MATCH_MAX_CANDIDATES,
  MATCH_TERM_SIMILARITY,
  buildMatchPlan,
  buildMatchRank,
  groupCandidates,
  mergeRank,
} from "@bs/core";
import { contactSearch, failContactSearch, nearestPainHits, saveContactSearch, sharingCommenters, termHits } from "@bs/db";
import { type Deps } from "./deps.ts";
import { refreshPainStatements } from "./trends.ts";

// ── contact-search: only from the operator's click ──────────────────────────
// Plan (one AI call) → the 60 nearest pain statements to the plan's pains, the commenters who
// shared the pain on those posts, and for providers the people whose headline or comment uses the
// plan's words → grouped by person, the 25 nearest ranked (one AI call). Both calls and the
// embeddings sit inside the monthly AI cap; a search costs about a cent.
export async function contactSearchJob(d: Pick<Deps, "pool" | "llm" | "embedder" | "log">, job: ContactSearch): Promise<string> {
  const s = await contactSearch(d.pool, job.searchId);
  if (!s) return "search gone";
  if (s.status !== "queued") return "already done";
  const fail = async (e: unknown) => {
    if ((e as { retryable?: unknown }).retryable === false) await failContactSearch(d.pool, s.id, (e as Error).message);
    throw e;
  };
  const fresh = await refreshPainStatements(d);
  const plan = await d.llm.json("match", buildMatchPlan(s.query)).catch(fail);
  const q = await d.embedder.embed(plan.data.pains);
  const nearest = await nearestPainHits(d.pool, q.vectors, 60);
  const posts = new Map<string, number>();
  for (const h of nearest) posts.set(h.postId, Math.max(posts.get(h.postId) ?? 0, h.similarity));
  const sharing = await sharingCommenters(d.pool, [...posts].map(([postId, sim]) => ({ postId, similarity: sim * 0.9 })));
  const terms = plan.data.seeking === "providers" ? await termHits(d.pool, plan.data.terms, MATCH_TERM_SIMILARITY, 60) : [];
  const candidates = groupCandidates([...nearest, ...sharing, ...terms], MATCH_MAX_CANDIDATES);
  let costUsd = fresh.costUsd + plan.costUsd + q.costUsd;
  let results: ReturnType<typeof mergeRank> = [];
  let model = plan.model;
  if (candidates.length) {
    const rank = await d.llm.json("match", buildMatchRank(s.query, plan.data, candidates)).catch(fail);
    results = mergeRank(candidates, rank.data);
    costUsd += rank.costUsd;
    model = rank.model;
  }
  await saveContactSearch(d.pool, { id: s.id, plan: plan.data, results, candidates: candidates.length, model, costUsd });
  return `${results.length} of ${candidates.length} people matched ($${costUsd.toFixed(4)})`;
}
