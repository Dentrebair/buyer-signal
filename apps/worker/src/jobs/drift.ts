// The daily drift check.
import {
  DRIFT_METRICS,
  type DriftMetric,
  compareDrift,
} from "@bs/core";
import {
  driftCounts,
  saveDriftChecks,
} from "@bs/db";
import { type Deps } from "./deps.ts";

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
