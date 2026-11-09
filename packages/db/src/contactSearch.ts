// Contact search (migration 0028): the request, the people behind the nearest pain statements, and
// the result. People come from LinkedIn posts and comments only; job posts name no person.
import type { ContactMatch, MatchHit, MatchPlan } from "@bs/core";
import type { Db } from "./pool.ts";

export async function contactSearch(db: Db, id: string): Promise<{ id: string; query: string; status: string } | null> {
  return (await db.query("select id, query, status from contact_searches where id = $1", [id])).rows[0] ?? null;
}

const HIT_COLUMNS = `name, headline, profile_url "profileUrl", company, relation, point, similarity, post_id "postId", post_url "postUrl",
  post_author "postAuthor", post_excerpt "postExcerpt", comment_url "commentUrl", comment_excerpt "commentExcerpt", role`;

// The statements nearest any of the plan's pains (cosine), with their post author or commenter.
export async function nearestPainHits(db: Db, vectors: number[][], limit: number): Promise<MatchHit[]> {
  if (!vectors.length) return [];
  return (
    await db.query<MatchHit>(
      `with q as (select unnest($1::text[])::vector v),
       s as (
         select s.source, s.source_id, s.text, max(1 - (s.embedding <=> q.v)) similarity
           from pain_statements s cross join q
          where s.source in ('li_post', 'li_comment') and s.embedding is not null
          group by s.id order by similarity desc limit $2
       ),
       hits as (
         select 'author' role, p.author_name name, p.author_headline headline, p.author_url profile_url, p.author_company company,
                p.author_relation relation, s.text point, s.similarity, p.id::text post_id, p.url post_url, p.author_name post_author,
                left(p.body, 400) post_excerpt, null::text comment_url, null::text comment_excerpt
           from s join li_posts p on p.id = s.source_id::uuid where s.source = 'li_post'
         union all
         select 'commenter', k.name, k.headline, k.profile_url, k.company, null, s.text, s.similarity, p.id::text, p.url, p.author_name,
                left(p.body, 400), k.url, left(k.body, 400)
           from s join li_comments k on k.id = s.source_id::uuid join li_posts p on p.id = k.li_post_id where s.source = 'li_comment'
       )
       select ${HIT_COLUMNS} from hits`,
      [vectors.map((v) => `[${v.join(",")}]`), limit],
    )
  ).rows.map(num);
}

// Commenters who shared the pain (or added to it) on the posts that matched, though their own words
// were not among the nearest: they are contacts for the same problem. `similarity` is the post's.
export async function sharingCommenters(db: Db, posts: { postId: string; similarity: number }[]): Promise<MatchHit[]> {
  if (!posts.length) return [];
  return (
    await db.query<MatchHit>(
      `with q as (select * from unnest($1::uuid[], $2::float8[]) as q(post_id, similarity))
       select ${HIT_COLUMNS} from (
         select 'commenter' role, k.name, k.headline, k.profile_url, k.company, null relation, k.gist point, q.similarity,
                p.id::text post_id, p.url post_url, p.author_name post_author, left(p.body, 400) post_excerpt, k.url comment_url, left(k.body, 400) comment_excerpt
           from q join li_posts p on p.id = q.post_id join li_comments k on k.li_post_id = p.id
          where not k.is_author and (k.resonates or k.reply_kind in ('shares', 'perspective')) and length(k.gist) > 10
       ) x`,
      [posts.map((p) => p.postId), posts.map((p) => p.similarity)],
    )
  ).rows.map(num);
}

// For providers: people whose headline or comment uses the plan's words. Case-insensitive, the
// words passed as parameters (never into the SQL), % and _ escaped.
export async function termHits(db: Db, terms: string[], similarity: number, limit: number): Promise<MatchHit[]> {
  const patterns = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (!patterns.length) return [];
  return (
    await db.query<MatchHit>(
      `select ${HIT_COLUMNS} from (
         select 'author' role, p.author_name name, p.author_headline headline, p.author_url profile_url, p.author_company company,
                p.author_relation relation, coalesce(p.pains ->> 0, left(p.body, 200)) point, $2::float8 similarity, p.id::text post_id, p.url post_url,
                p.author_name post_author, left(p.body, 400) post_excerpt, null::text comment_url, null::text comment_excerpt
           from li_posts p where p.author_headline ilike any ($1::text[])
         union all
         select 'commenter', k.name, k.headline, k.profile_url, k.company, null, coalesce(nullif(k.gist, ''), left(k.body, 200)), $2::float8,
                p.id::text, p.url, p.author_name, left(p.body, 400), k.url, left(k.body, 400)
           from li_comments k join li_posts p on p.id = k.li_post_id
          where not k.is_author and (k.headline ilike any ($1::text[]) or k.body ilike any ($1::text[]))
       ) x limit $3`,
      [patterns, similarity, limit],
    )
  ).rows.map(num);
}

const num = (h: MatchHit): MatchHit => ({ ...h, similarity: Number(h.similarity) });

export async function saveContactSearch(
  db: Db,
  x: { id: string; plan: MatchPlan; results: ContactMatch[]; candidates: number; model: string; costUsd: number },
): Promise<void> {
  await db.query(
    "update contact_searches set status = 'done', plan = $2, results = $3, candidates = $4, model = $5, cost_usd = $6, finished_at = now() where id = $1",
    [x.id, x.plan, JSON.stringify(x.results), x.candidates, x.model, x.costUsd],
  );
}

export async function failContactSearch(db: Db, id: string, error: string): Promise<void> {
  await db.query("update contact_searches set status = 'error', error = $2, finished_at = now() where id = $1 and status = 'queued'", [id, error.slice(0, 300)]);
}

// poll-runs: a search still running after 10 minutes failed somewhere; results older than the
// LinkedIn rows they name (60 days) go with them.
export async function expireContactSearches(db: Db): Promise<number> {
  const a = await db.query("update contact_searches set status = 'error', error = 'Timed out', finished_at = now() where status = 'queued' and requested_at < now() - interval '10 minutes'");
  const b = await db.query("delete from contact_searches where requested_at < now() - interval '60 days'");
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}
