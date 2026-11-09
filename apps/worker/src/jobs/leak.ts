// Leak check (audit-dropped, §6.3 step 6) and the approved phrases it adds to the trie.
import {
  type ApprovedAtoms,
  AUDIT_PER_DAY,
  buildLeakCheck,
} from "@bs/core";
import {
  approvedAtoms,
  markSampleError,
  pendingSamples,
  saveLeakCheck,
  withTransaction,
} from "@bs/db";
import { type Deps } from "./deps.ts";

// ── audit-dropped: daily leak check (§6.3 step 6) ────────────────────────────
// Phrases the operator approved join the trie; read at most once a minute.
const APPROVED_TTL_MS = 60_000;
let approvedCache: { at: number; value: ApprovedAtoms } | null = null;
export async function approvedAtomsCached(d: Pick<Deps, "pool">): Promise<ApprovedAtoms> {
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
