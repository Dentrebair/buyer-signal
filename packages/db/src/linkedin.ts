// LinkedIn post search (PRD §4.1d): posts, comments and the AI's read of them.
import type pg from "pg";
import { type LiCardOutcome, type LiComment, type LiPost, type LiRead, commentPainScore, emailsIn, liCommentCardGate } from "@bs/core";
import type { Db } from "./pool.ts";

// Saves a run's posts and their comments; returns the ids of posts new to this run (a retry adds nothing).
export async function saveLiItems(c: pg.PoolClient, runId: string, posts: LiPost[], comments: LiComment[]): Promise<string[]> {
  if (!posts.length) return [];
  // One statement for the posts and one for their comments (≈ 150 ms a round trip: a run of 2,000
  // items one row at a time took minutes inside this transaction). Only posts new to the run get
  // their comments, so a retry adds nothing.
  const inserted = (
    await c.query<{ id: string; post_id: string }>(
      `insert into li_posts (run_id, post_id, url, posted_at, body, author_type, author_name, author_headline, author_url, author_website,
                             likes, comment_count, shares, emails)
       select $1, x.post_id, x.url, x.posted_at, x.body, x.author_type, x.author_name, x.author_headline, x.author_url, x.author_website,
              x.likes, x.comment_count, x.shares, x.emails
         from jsonb_to_recordset($2::jsonb) as x(post_id text, url text, posted_at timestamptz, body text, author_type text, author_name text,
              author_headline text, author_url text, author_website text, likes int, comment_count int, shares int, emails text[])
       on conflict (run_id, post_id) do nothing returning id, post_id`,
      [
        runId,
        JSON.stringify(
          posts.map((p) => ({
            post_id: p.postId, url: p.url, posted_at: p.postedAt, body: p.text, author_type: p.authorType, author_name: p.authorName,
            author_headline: p.authorHeadline, author_url: p.authorUrl, author_website: p.authorWebsite, likes: p.likes,
            comment_count: p.comments, shares: p.shares, emails: emailsIn(p.text, p.authorHeadline),
          })),
        ),
      ],
    )
  ).rows;
  const idOf = new Map(inserted.map((r) => [r.post_id, r.id]));
  const rows = comments
    .filter((k) => idOf.has(k.postId))
    .map((k) => ({
      li_post_id: idOf.get(k.postId), comment_id: k.commentId, url: k.url, body: k.text, commented_at: k.createdAt, actor_type: k.actorType,
      name: k.name, headline: k.headline, profile_url: k.profileUrl, is_author: k.isAuthor, likes: k.likes, emails: emailsIn(k.text, k.headline),
    }));
  if (rows.length)
    await c.query(
      `insert into li_comments (li_post_id, comment_id, url, body, commented_at, actor_type, name, headline, profile_url, is_author, likes, emails)
       select * from jsonb_to_recordset($1::jsonb) as x(li_post_id uuid, comment_id text, url text, body text, commented_at timestamptz,
              actor_type text, name text, headline text, profile_url text, is_author boolean, likes int, emails text[])
       on conflict (li_post_id, comment_id) do nothing`,
      [JSON.stringify(rows)],
    );
  // In the order the run returned them, as before.
  return posts.flatMap((p) => (idOf.has(p.postId) ? [idOf.get(p.postId)!] : []));
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
// `card`: the post's card gate verdict ('checking' while the card job runs). Returns the comments
// that passed their own card gate (liCommentCardGate), now 'checking'.
export async function saveLiRead(c: pg.PoolClient, id: string, read: LiRead, comments: { id: string; body: string }[], card: LiCardOutcome): Promise<string[]> {
  await c.query(
    `update li_posts set status = 'read', has_pain = $2, pains = $3, stance = $4, author_relation = $5, author_company = $6, author_country = $7,
                         card_outcome = $8, read_at = now()
      where id = $1`,
    [id, read.has_pain, JSON.stringify(read.has_pain ? read.pains : []), read.stance, read.author_relation, read.author_company?.trim() || null,
      read.author_country, card],
  );
  const toCard: string[] = [];
  for (const k of read.comments) {
    const n = Number(/^c(\d+)$/.exec(k.ref)?.[1]);
    const seen = comments[n - 1];
    if (!seen) continue; // a ref the prompt never had
    const pain = commentPainScore(k, seen.body);
    const gate = liCommentCardGate(k);
    const r = await c.query(
      `update li_comments set resonates = $2, gist = $3, company = $4, urgency = $6, signals = $7, urgency_pct = $8, depth_pct = $9, pain_score = $10,
                              reply_kind = $11, relation = $12, country = $13, card_outcome = $14
        where id = $1 and li_post_id = $5`,
      [seen.id, k.resonates, k.gist, k.company?.trim() || null, id, k.urgency, pain.signals, pain.urgencyPct, pain.depthPct, pain.score, k.reply_kind,
        k.relation, k.country, gate.ok ? "checking" : gate.outcome],
    );
    if (gate.ok && r.rowCount) toCard.push(seen.id);
  }
  return toCard;
}

// What a commenter's card job needs: the comment, the gate's inputs, and the post it answers.
export interface LiCommentForCard {
  id: string;
  commentId: string;
  url: string | null;
  body: string;
  headline: string | null;
  company: string | null;
  relation: string | null;
  country: string | null;
  replyKind: "shares" | "perspective" | "unhelpful" | null;
  cardOutcome: LiCardOutcome | null;
  commentedAt: Date | null;
  postBody: string;
  postUrl: string;
  postedAt: Date | null;
  runId: string;
  vertical: string | null;
}
export async function liCommentForCard(db: Db, id: string): Promise<LiCommentForCard | null> {
  const r = (
    await db.query<LiCommentForCard>(
      `select k.id, k.comment_id "commentId", k.url, k.body, k.headline, k.company, k.relation, k.country, k.reply_kind "replyKind",
              k.card_outcome "cardOutcome", k.commented_at "commentedAt", p.body "postBody", p.url "postUrl", p.posted_at "postedAt",
              p.run_id "runId", r.vertical
         from li_comments k join li_posts p on p.id = k.li_post_id join ingestion_runs r on r.id = p.run_id where k.id = $1`,
      [id],
    )
  ).rows[0];
  return r ?? null;
}

export async function setLiCommentCardOutcome(db: Db, id: string, outcome: LiCardOutcome): Promise<void> {
  await db.query("update li_comments set card_outcome = $2 where id = $1", [id, outcome]);
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
  await db.query(
    `update li_comments k set card_outcome = 'ai_error' from li_posts p
      where p.id = k.li_post_id and k.card_outcome = 'checking' and p.created_at < now() - interval '1 hour'`,
  );
  const r = await db.query("delete from li_posts where created_at < now() - make_interval(days => $1)", [days]);
  return r.rowCount ?? 0;
}
