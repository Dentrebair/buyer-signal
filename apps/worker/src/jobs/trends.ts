// Anonymous pain trends (§5.6).
import {
  type TrendSource,
  TREND_MAX_PER_VERTICAL,
  TREND_MIN_SIZE,
  TREND_RECENT_DAYS,
  TREND_WINDOW_DAYS,
  buildTrendLabel,
  centralMembers,
  clusterVectors,
} from "@bs/core";
import {
  collectPainStatements,
  previousTrendLabels,
  replaceTrends,
  saveEmbeddings,
  statementsToEmbed,
  trendStatements,
  type TrendClusterRow,
  withTransaction,
} from "@bs/db";
import { type Deps } from "./deps.ts";

// ── trends (§5.6): weekly, and Run now on /trends ────────────────────────────
// New pain statements are embedded (≈ $0.00001 each), then each vertical's last 180 days are
// grouped by meaning; a group of 3 or more is named by the AI (≈ $0.0003), unless it kept most of
// last run's members, when it keeps last run's name.
export async function trendsJob(d: Pick<Deps, "pool" | "llm" | "embedder" | "now" | "log">): Promise<{ added: number; embedded: number; groups: number; named: number; reused: number }> {
  const { added, embedded } = await refreshPainStatements(d);
  const now = d.now().getTime();
  const DAY = 86_400_000;
  const all = await trendStatements(d.pool, TREND_WINDOW_DAYS);
  const byVertical = new Map<string | null, typeof all>();
  for (const s of all) byVertical.set(s.vertical, [...(byVertical.get(s.vertical) ?? []), s]);
  const before = await previousTrendLabels(d.pool);
  const reuse = (ids: string[]) => {
    const mine = new Set(ids);
    for (const p of before) {
      const shared = p.member_ids.filter((x) => mine.has(x)).length;
      if (shared / (mine.size + p.member_ids.length - shared) >= 0.6) return p; // most members the same
    }
    return null;
  };
  const rows: TrendClusterRow[] = [];
  let named = 0;
  let reused = 0;
  for (const [vertical, items] of byVertical)
    for (const members of clusterVectors(items.slice(-TREND_MAX_PER_VERTICAL))) { // statements come oldest first
      const age = (m: (typeof members)[number]) => (now - new Date(m.seen_at).getTime()) / DAY;
      const sources: Partial<Record<TrendSource, number>> = {};
      for (const m of members) sources[m.source] = (sources[m.source] ?? 0) + 1;
      const ids = members.map((m) => m.id);
      const examples = centralMembers(members, 5).map((m) => m.text);
      let label: string | null = null;
      let summary: string | null = null;
      if (members.length >= TREND_MIN_SIZE) {
        const had = reuse(ids);
        if (had) {
          ({ label, summary } = had);
          reused++;
        } else {
          const out = await d.llm.json("extraction", buildTrendLabel({ vertical, statements: centralMembers(members, 12).map((m) => m.text) }));
          ({ label, summary } = out.data);
          named++;
        }
      }
      rows.push({
        vertical,
        label,
        summary,
        size: members.length,
        recent: members.filter((m) => age(m) <= TREND_RECENT_DAYS).length,
        previous: members.filter((m) => age(m) > TREND_RECENT_DAYS && age(m) <= 2 * TREND_RECENT_DAYS).length,
        sources,
        examples,
        member_ids: ids,
      });
    }
  await withTransaction(d.pool, (c) => replaceTrends(c, rows));
  const out = { added, embedded, groups: rows.length, named, reused };
  d.log("trends built", out);
  return out;
}

// Copies in the pain read since the last run and embeds it. Also run by contact search, so a
// search sees posts read since Monday's trends.
export async function refreshPainStatements(d: Pick<Deps, "pool" | "embedder">): Promise<{ added: number; embedded: number; costUsd: number }> {
  const added = await collectPainStatements(d.pool);
  let embedded = 0;
  let costUsd = 0;
  for (let batch = await statementsToEmbed(d.pool, 100); batch.length; batch = await statementsToEmbed(d.pool, 100)) {
    const out = await d.embedder.embed(batch.map((b) => b.text));
    await saveEmbeddings(d.pool, batch.map((b, i) => ({ id: b.id, vec: out.vectors[i]! })));
    embedded += batch.length;
    costUsd += out.costUsd;
  }
  return { added, embedded, costUsd };
}
