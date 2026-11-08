// /trends (§5.6, §10.5): the pains businesses keep describing, grouped by meaning per vertical.
import type { TrendSource } from "@bs/core";
import { asOperator } from "./operator.ts";

export interface Trend {
  id: string;
  vertical: string | null;
  label: string;
  summary: string | null;
  size: number;
  recent: number;
  previous: number;
  sources: Partial<Record<TrendSource, number>>;
  examples: string[];
}

export interface TrendsPage {
  trends: Trend[]; // named groups (3+ statements), largest first
  verticals: { vertical: string | null; trends: number; statements: number }[];
  statements: number;
  bySource: Partial<Record<TrendSource, number>>;
  ungrouped: number; // statements in groups too small to name
  builtAt: string | null;
}

export function loadTrends(vertical: string | null | "any"): Promise<TrendsPage> {
  return asOperator(async (c) => {
    const trends = (
      await c.query<Trend>(
        `select id, vertical, label, summary, size, recent, previous, sources, examples from trend_clusters
          where label is not null and ($1::text is null or vertical is not distinct from nullif($1, 'any'))
          order by size desc, recent desc`,
        [vertical],
      )
    ).rows;
    const verticals = (
      await c.query<{ vertical: string | null; trends: number; statements: number }>(
        `select vertical, count(*) filter (where label is not null)::int trends, sum(size)::int statements
           from trend_clusters group by vertical order by 2 desc, 3 desc`,
      )
    ).rows;
    const st = (
      await c.query<{ statements: number; ungrouped: number; built_at: string | null }>(
        `select (select count(*) from pain_statements)::int statements,
                (select coalesce(sum(size), 0) from trend_clusters where label is null)::int ungrouped,
                (select max(built_at) from trend_clusters) built_at`,
      )
    ).rows[0]!;
    const bySource: Partial<Record<TrendSource, number>> = {};
    for (const r of (await c.query<{ source: TrendSource; n: number }>("select source, count(*)::int n from pain_statements group by 1")).rows) bySource[r.source] = r.n;
    return { trends, verticals, statements: st.statements, bySource, ungrouped: st.ungrouped, builtAt: st.built_at };
  });
}
