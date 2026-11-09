// Job-board datasets (Indeed): freshness, dedup and the keyword gate, then extraction.
import {
  type FetchDataset,
  type ExtractLlmInput,
  ExtractLlm,
  Q,
  type VerticalSlug,
  checkFreshness,
  gateJobPost,
  sampled,
  trieFor,
} from "@bs/core";
import {
  type DropCounter,
  bumpCounters,
  markSeen,
  setRunStatus,
  recordDropSample,
  withTransaction,
} from "@bs/db";
import {
  mapIndeedItem,
} from "@bs/integrations";
import { archiveRaw } from "./archive.ts";
import { extractLlm } from "./cards.ts";
import { type Deps, PAGE, drop } from "./deps.ts";
import { approvedAtomsCached } from "./leak.ts";

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
