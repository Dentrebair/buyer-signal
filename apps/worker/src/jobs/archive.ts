// Raw payload archive (Q64).
import {
  SAMPLE_KEEP_DAYS,
  type RawSource,
  RAW_KEEP_DAYS,
} from "@bs/core";
import {
  purgeDropSamples,
} from "@bs/db";
import { type Deps } from "./deps.ts";

// ── Raw payload archive (Q64) ───────────────────────────────────────────────
// A convenience for re-runs, never a reason to lose a run: a failed upload is logged and the
// fetch carries on.
export async function archiveRaw(d: Deps, source: RawSource, runId: string, part: string, items: unknown[]): Promise<void> {
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
