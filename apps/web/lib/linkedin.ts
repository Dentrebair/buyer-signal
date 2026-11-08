// LinkedIn post search page (PRD §4.1d): the latest runs, and one run's posts with their comments.
import { asOperator } from "./operator.ts";

export interface LiRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  vertical: string | null;
  topic: string | null;
  posts: number;
  pain: number;
  reading: number; // posts the AI is still reading or checking for a card
  cards: number;
  contacts: number;
  cost_usd: number;
}

export interface LiCommentRow {
  id: string;
  url: string | null;
  body: string;
  actor_type: "person" | "company";
  name: string | null;
  headline: string | null;
  profile_url: string | null;
  company: string | null;
  gist: string | null;
  resonates: boolean | null;
  emails: string[];
  commented_at: string | null;
  likes: number;
  urgency: "none" | "nuisance" | "recurring" | "blocking" | null;
  signals: string[];
  urgency_pct: number | null;
  depth_pct: number | null;
  pain_score: number | null;
  reply_kind: "shares" | "perspective" | "unhelpful" | null; // null: read before 2026-11-08's label
  card_outcome: string | null; // the commenter's own card, or why not (null: read before commenter cards)
  card_company_id: string | null;
}

export interface LiPostRow {
  id: string;
  url: string;
  posted_at: string | null;
  body: string;
  author_type: "person" | "company";
  author_name: string | null;
  author_headline: string | null;
  author_url: string | null;
  author_website: string | null;
  author_company: string | null;
  author_relation: string | null;
  stance: string | null;
  likes: number;
  comment_count: number;
  status: "reading" | "read" | "ai_error";
  has_pain: boolean | null;
  pains: string[];
  emails: string[];
  author_country: string | null;
  card_outcome: string | null; // whether it became an inbox card, and why not (§4.1d)
  card_company_id: string | null;
  eval_label: "lead" | "pain" | "none" | null; // the operator's label for the AI test set
  comments: LiCommentRow[];
}

export interface LinkedinPage {
  runs: LiRun[];
  shown: LiRun | null;
  posts: LiPostRow[];
  running: boolean;
}

const ACTIVE = ["starting", "running", "fetching"];

export function loadLinkedin(runId?: string | null): Promise<LinkedinPage> {
  return asOperator(async (c) => {
    const runs = (
      await c.query<LiRun>(
        `select r.id, r.started_at, r.completed_at, r.status, r.vertical, r.query_title topic,
                (select count(*) from li_posts p where p.run_id = r.id)::int posts,
                (select count(*) from li_posts p where p.run_id = r.id and p.has_pain)::int pain,
                (select count(*) from li_posts p where p.run_id = r.id and (p.status = 'reading' or p.card_outcome = 'checking'))::int reading,
                (select count(*) from li_posts p where p.run_id = r.id and p.card_outcome = 'card')::int cards,
                (select count(*) from li_posts p where p.run_id = r.id)::int
                  + (select count(*) from li_comments k join li_posts p on p.id = k.li_post_id where p.run_id = r.id and not k.is_author)::int contacts,
                coalesce((select sum(e.cost_usd) from spend_events e where e.run_id = r.id), r.estimated_cost_usd)::float cost_usd
           from ingestion_runs r where r.job_type = 'li_posts'
          order by r.started_at desc limit 10`,
      )
    ).rows;
    const shown = runs.find((r) => r.id === runId) ?? runs[0] ?? null;
    let posts: LiPostRow[] = [];
    if (shown) {
      posts = (
        await c.query<Omit<LiPostRow, "comments">>(
          `select p.id, p.url, p.posted_at, p.body, p.author_type, p.author_name, p.author_headline, p.author_url, p.author_website, p.author_company,
                  p.author_relation, p.stance, p.likes, p.comment_count, p.status, p.has_pain, p.pains, p.emails, p.author_country, p.card_outcome,
                  ch.company_id card_company_id, ec.label eval_label
             from li_posts p left join challenges ch on ch.natural_id = 'post:linkedin:' || p.post_id
             left join eval_cases ec on ec.li_post_id = p.id
            where p.run_id = $1
            order by p.has_pain desc nulls last, p.likes + p.comment_count desc`,
          [shown.id],
        )
      ).rows.map((p) => ({ ...p, comments: [] }));
      const comments = (
        await c.query<LiCommentRow & { li_post_id: string }>(
          `select k.li_post_id, k.id, k.url, k.body, k.actor_type, k.name, k.headline, k.profile_url, k.company, k.gist, k.resonates, k.emails,
                  k.commented_at, k.likes, k.urgency, k.signals, k.urgency_pct, k.depth_pct, k.pain_score, k.reply_kind, k.card_outcome,
                  kch.company_id card_company_id
             from li_comments k join li_posts p on p.id = k.li_post_id
             left join challenges kch on kch.natural_id = 'comment:linkedin:' || k.comment_id
            where p.run_id = $1 and not k.is_author
            order by k.resonates desc nulls last, k.pain_score desc nulls last, k.likes desc`,
          [shown.id],
        )
      ).rows;
      const byPost = new Map(posts.map((p) => [p.id, p]));
      for (const { li_post_id, ...k } of comments) byPost.get(li_post_id)?.comments.push(k);
    }
    const running = runs.some((r) => ACTIVE.includes(r.status) || r.reading > 0);
    return { runs, shown, posts, running };
  });
}
