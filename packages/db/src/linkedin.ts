// LinkedIn post search (PRD §4.1d): posts, comments and the AI's read of them.
import type pg from "pg";
import { type LiCardOutcome, type LiComment, type LiPost, type LiRead, commentPainScore, emailsIn } from "@bs/core";
import type { Db } from "./pool.ts";

// Saves a run's posts and their comments; returns the ids of posts new to this run (a retry adds nothing).
export async function saveLiItems(c: pg.PoolClient, runId: string, posts: LiPost[], comments: LiComment[]): Promise<string[]> {
  const ids: string[] = [];
  for (const p of posts) {
    const r = await c.query<{ id: string }>(
      `insert into li_posts (run_id, post_id, url, posted_at, body, author_type, author_name, author_headline, author_url, author_website,
                             likes, comment_count, shares, emails)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (run_id, post_id) do nothing returning id`,
      [runId, p.postId, p.url, p.postedAt, p.text, p.authorType, p.authorName, p.authorHeadline, p.authorUrl, p.authorWebsite,
        p.likes, p.comments, p.shares, emailsIn(p.text, p.authorHeadline)],
    );
    const id = r.rows[0]?.id;
    if (!id) continue;
    ids.push(id);
    for (const k of comments.filter((x) => x.postId === p.postId)) {
      await c.query(
        `insert into li_comments (li_post_id, comment_id, url, body, commented_at, actor_type, name, headline, profile_url, is_author, likes, emails)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (li_post_id, comment_id) do nothing`,
        [id, k.commentId, k.url, k.text, k.createdAt, k.actorType, k.name, k.headline, k.profileUrl, k.isAuthor, k.likes, emailsIn(k.text, k.headline)],
      );
    }
  }
  return ids;
}

export interface LiPostToRead {
  id: string;
  runId: string;
  status: string;
  body: string;
  authorType: string;
  authorHeadline: string | null;
  comments: { id: string; body: string; headline: string | null; actorType: string }[];
}

// The post and the comments the AI reads: the author's own replies are left out, longest-liked first.
export async function liPostToRead(db: Db, id: string, maxComments: number): Promise<LiPostToRead | null> {
  const p = (
    await db.query<{ id: string; run_id: string; status: string; body: string; author_type: string; author_headline: string | null }>(
      "select id, run_id, status, body, author_type, author_headline from li_posts where id = $1",
      [id],
    )
  ).rows[0];
  if (!p) return null;
  const comments = (
    await db.query<{ id: string; body: string; headline: string | null; actor_type: string }>(
      `select id, body, headline, actor_type from li_comments where li_post_id = $1 and not is_author and length(trim(body)) > 0
        order by likes desc, commented_at limit $2`,
      [id, maxComments],
    )
  ).rows;
  return {
    id: p.id,
    runId: p.run_id,
    status: p.status,
    body: p.body,
    authorType: p.author_type,
    authorHeadline: p.author_headline,
    comments: comments.map((c) => ({ id: c.id, body: c.body, headline: c.headline, actorType: c.actor_type })),
  };
}

// `comments`: the li_comments the AI saw, in its order (its refs are c1, c2, …), with their text.
// `card`: the card gate's verdict ('checking' while the card job runs).
export async function saveLiRead(c: pg.PoolClient, id: string, read: LiRead, comments: { id: string; body: string }[], card: LiCardOutcome): Promise<void> {
  await c.query(
    `update li_posts set status = 'read', has_pain = $2, pains = $3, stance = $4, author_relation = $5, author_company = $6, author_country = $7,
                         card_outcome = $8, read_at = now()
      where id = $1`,
    [id, read.has_pain, JSON.stringify(read.has_pain ? read.pains : []), read.stance, read.author_relation, read.author_company?.trim() || null,
      read.author_country, card],
  );
  for (const k of read.comments) {
    const n = Number(/^c(\d+)$/.exec(k.ref)?.[1]);
    const seen = comments[n - 1];
    if (!seen) continue; // a ref the prompt never had
    const pain = commentPainScore(k, seen.body);
    await c.query(
      `update li_comments set resonates = $2, gist = $3, company = $4, urgency = $6, signals = $7, urgency_pct = $8, depth_pct = $9, pain_score = $10,
                              reply_kind = $11
        where id = $1 and li_post_id = $5`,
      [seen.id, k.resonates, k.gist, k.company?.trim() || null, id, k.urgency, pain.signals, pain.urgencyPct, pain.depthPct, pain.score, k.reply_kind],
    );
  }
}

// What the card job needs: the post, the read's verdict, and its run's vertical.
export interface LiPostForCard {
  id: string;
  runId: string;
  postId: string;
  url: string;
  postedAt: Date | null;
  body: string;
  authorHeadline: string | null;
  authorRelation: string | null;
  stance: string | null;
  authorCompany: string | null;
  authorCountry: string | null;
  hasPain: boolean | null;
  cardOutcome: LiCardOutcome | null;
  vertical: string | null;
}
export async function liPostForCard(db: Db, id: string): Promise<LiPostForCard | null> {
  const r = (
    await db.query<LiPostForCard>(
      `select p.id, p.run_id "runId", p.post_id "postId", p.url, p.posted_at "postedAt", p.body, p.author_headline "authorHeadline",
              p.author_relation "authorRelation", p.stance, p.author_company "authorCompany", p.author_country "authorCountry",
              p.has_pain "hasPain", p.card_outcome "cardOutcome", r.vertical
         from li_posts p join ingestion_runs r on r.id = p.run_id where p.id = $1`,
      [id],
    )
  ).rows[0];
  return r ?? null;
}

export async function setLiCardOutcome(db: Db, id: string, outcome: LiCardOutcome): Promise<void> {
  await db.query("update li_posts set card_outcome = $2 where id = $1", [id, outcome]);
}

export async function markLiError(db: Db, id: string): Promise<void> {
  await db.query("update li_posts set status = 'ai_error' where id = $1 and status = 'reading'", [id]);
}

// Personal data (§4.1d): 60 days, then gone. A post the AI never finished stops "reading" (or its
// card "checking") after an hour.
export async function purgeLinkedin(db: Db, days = 60): Promise<number> {
  await db.query("update li_posts set status = 'ai_error' where status = 'reading' and created_at < now() - interval '1 hour'");
  await db.query("update li_posts set card_outcome = 'ai_error' where card_outcome = 'checking' and created_at < now() - interval '1 hour'");
  const r = await db.query("delete from li_posts where created_at < now() - make_interval(days => $1)", [days]);
  return r.rowCount ?? 0;
}
