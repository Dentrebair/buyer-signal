// Anonymous pain trends (migration 0027, §5.6): pain statements from what the pipeline has read,
// their embeddings, and the groups built from them.
import type pg from "pg";
import type { TrendSource } from "@bs/core";
import type { Db } from "./pool.ts";

// New statements from each source since the last run. Safe to run twice (unique per source row).
// Only AI-written text is copied: a job post's manual work, a post's pains, a comment's critical
// point; never a name or a quote. Sample cards count: not live leads, but real posts' real pain.
export async function collectPainStatements(db: Db): Promise<number> {
  let n = 0;
  n += (
    await db.query(
      `insert into pain_statements (source, source_id, vertical, country, text, seen_at)
       select 'job_post', ch.id::text, c.vertical, c.country, ch.structured_intelligence ->> 'verified_symptom', coalesce(ch.posted_at, ch.created_at)
         from challenges ch join companies c on c.id = ch.company_id
        where ch.source_type = 'job_post' and length(ch.structured_intelligence ->> 'verified_symptom') > 10
       on conflict (source, source_id, part) do nothing`,
    )
  ).rowCount!;
  n += (
    await db.query(
      `insert into pain_statements (source, source_id, part, vertical, country, text, seen_at)
       select 'li_post', p.id::text, (x.ord - 1)::int, r.vertical, case when p.author_country in ('in', 'ae', 'us') then p.author_country end, x.pain,
              coalesce(p.posted_at, p.created_at)
         from li_posts p join ingestion_runs r on r.id = p.run_id
         cross join lateral jsonb_array_elements_text(p.pains) with ordinality as x(pain, ord)
        where p.has_pain and length(x.pain) > 10
       on conflict (source, source_id, part) do nothing`,
    )
  ).rowCount!;
  n += (
    await db.query(
      `insert into pain_statements (source, source_id, vertical, country, text, seen_at)
       select 'li_comment', k.id::text, r.vertical, case when k.country in ('in', 'ae', 'us') then k.country end, k.gist, coalesce(k.commented_at, p.created_at)
         from li_comments k join li_posts p on p.id = k.li_post_id join ingestion_runs r on r.id = p.run_id
        where (k.resonates or k.reply_kind = 'perspective') and length(k.gist) > 10
       on conflict (source, source_id, part) do nothing`,
    )
  ).rowCount!;
  return n;
}

export async function statementsToEmbed(db: Db, limit: number): Promise<{ id: string; text: string }[]> {
  return (await db.query("select id, text from pain_statements where embedding is null order by created_at limit $1", [limit])).rows;
}

// One statement for the batch (one round trip per row took ≈ 15 s for 100).
export async function saveEmbeddings(db: Db, rows: { id: string; vec: number[] }[]): Promise<void> {
  if (!rows.length) return;
  await db.query(
    `update pain_statements p set embedding = v.e::vector from unnest($1::uuid[], $2::text[]) as v(id, e) where p.id = v.id`,
    [rows.map((r) => r.id), rows.map((r) => `[${r.vec.join(",")}]`)],
  );
}

export interface TrendStatement {
  id: string;
  source: TrendSource;
  vertical: string | null;
  text: string;
  seen_at: Date;
  vec: number[];
}

export async function trendStatements(db: Db, days: number): Promise<TrendStatement[]> {
  const rows = (
    await db.query<Omit<TrendStatement, "vec"> & { embedding: string }>(
      `select id, source, vertical, text, seen_at, embedding::text embedding from pain_statements
        where embedding is not null and seen_at > now() - make_interval(days => $1) order by seen_at`,
      [days],
    )
  ).rows;
  return rows.map(({ embedding, ...r }) => ({ ...r, vec: JSON.parse(embedding) as number[] }));
}

// Last run's named groups, so a group with the same members keeps its name without a new AI call.
export async function previousTrendLabels(db: Db): Promise<{ label: string; summary: string | null; member_ids: string[] }[]> {
  return (await db.query("select label, summary, member_ids from trend_clusters where label is not null")).rows;
}

export interface TrendClusterRow {
  vertical: string | null;
  label: string | null;
  summary: string | null;
  size: number;
  recent: number;
  previous: number;
  sources: Partial<Record<TrendSource, number>>;
  examples: string[];
  member_ids: string[];
}

// The whole set is replaced in one transaction, so the page never sees half a run.
export async function replaceTrends(c: pg.PoolClient, clusters: TrendClusterRow[]): Promise<void> {
  await c.query("delete from trend_clusters");
  if (!clusters.length) return;
  await c.query(
    `insert into trend_clusters (vertical, label, summary, size, recent, previous, sources, examples, member_ids)
     select * from jsonb_to_recordset($1::jsonb) as x(vertical text, label text, summary text, size int, recent int, previous int,
            sources jsonb, examples text[], member_ids uuid[])`,
    [JSON.stringify(clusters)],
  );
}
