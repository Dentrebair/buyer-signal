// LinkedIn post search (§4.1d): fetching a run, reading each post, and post or commenter cards.
import {
  ExtractLlm,
  type AuthorRelation,
  gateSnippet,
  type StructuredIntelligence,
  Q,
  type VerticalSlug,
  checkFreshness,
  type StartLiRun,
  type FetchLiRun,
  type ReadLiPost,
  type CardLiPost,
  type CardLiComment,
  liCommentCardGate,
  type LiRead,
  LI_ARM_COUNTRY,
  LI_MAX_COMMENTS,
  buildLiCardExtraction,
  liCardGate,
  LI_POST_ACTOR,
  LI_PRICES,
  buildLiRead,
  liItems,
  liSearchInput,
  mapLiItems,
  type LiCardOutcome,
} from "@bs/core";
import {
  type DropCounter,
  bumpCounters,
  setRunStatus,
  withTransaction,
  liPostToRead,
  liPostForCard,
  setLiCardOutcome,
  liCommentForCard,
  setLiCommentCardOutcome,
  markLiError,
  saveLiItems,
  saveLiRead,
  challengeExists,
} from "@bs/db";
import { archiveRaw } from "./archive.ts";
import { toCard } from "./cards.ts";
import { type Deps } from "./deps.ts";
import { startPaidRun } from "./runs.ts";

// ── LinkedIn post search (§4.1d) ────────────────────────────────────────────
// start-li-run: a paid run like any other (startPaidRun), reserving the worst case: every post and
// comment slot filled, for every topic. One Medium topic arm per topic, so the bandit learns from
// every run, rotation or Run now.
export function startLiRun(d: Deps, job: StartLiRun, jobKey: string): ReturnType<typeof startPaidRun> {
  return startPaidRun(d, {
    jobKey,
    retry: { queue: Q.startLiRun, job },
    plan: { maxItems: liItems({ ...job, topics: job.topics.length }), pricePerItem: LI_PRICES.post, startPrice: LI_PRICES["apify-actor-start"] },
    run: { jobType: "li_posts", vertical: job.vertical, country: null, queryTitle: job.topics.join(", ") },
    arms: job.topics.map((term) => ({ kind: "social" as const, vertical: job.vertical, country: LI_ARM_COUNTRY, term, group: "medium" as const })),
    actor: LI_POST_ACTOR,
    input: liSearchInput({ topics: job.topics, posts: job.posts, comments: job.comments }),
    log: { msg: "linkedin search started", extra: { topics: job.topics, posts: job.posts, comments: job.comments } },
  });
}

const LI_PAGE = 200;
const LI_MAX_ITEMS = 2000;

// Posts and comments arrive as separate items. Posts older than 21 days are dropped (§4.3; the
// actor's nearest window is a month); the rest are saved with their comments and each gets a read.
export async function fetchLiRun(d: Deps, job: FetchLiRun): Promise<Partial<Record<DropCounter, number>>> {
  const items: unknown[] = [];
  for (let offset = 0; offset < LI_MAX_ITEMS; offset += LI_PAGE) {
    const page = await d.apify.datasetItems<unknown>(job.datasetId, offset, LI_PAGE);
    items.push(...page);
    if (page.length < LI_PAGE) break;
  }
  await archiveRaw(d, "li_posts", job.runId, "all", items);
  const { posts, comments, skipped } = mapLiItems(items);
  const fresh = posts.filter((p) => checkFreshness(p.postedAt, d.now(), true).fresh);
  const counts: Partial<Record<DropCounter, number>> = {
    raw_items_ingested: posts.length,
    dropped_stale_count: posts.length - fresh.length,
    dropped_trie_count: skipped,
  };
  await withTransaction(d.pool, async (c) => {
    const ids = await saveLiItems(c, job.runId, fresh, comments);
    for (const liPostId of ids) await d.send(Q.readLiPost, { liPostId } satisfies ReadLiPost, undefined, c);
  });
  await bumpCounters(d.pool, job.runId, counts);
  await setRunStatus(d.pool, job.runId, "done");
  return counts;
}

// One AI call per post, with its comments: the pains, who wrote it, their company and market, and
// for each comment whether it shares the pain and what is critical in it. A post that passes the
// card gate (liCardGate) goes on to card-li-post.
export async function readLiPost(d: Deps, job: ReadLiPost): Promise<string> {
  const post = await liPostToRead(d.pool, job.liPostId, LI_MAX_COMMENTS);
  if (!post) return "post gone";
  if (post.status !== "reading") return "already read";
  const req = buildLiRead(
    { text: post.body, authorHeadline: post.authorHeadline, authorType: post.authorType },
    post.comments.map((c) => ({ text: c.body, headline: c.headline, actorType: c.actorType })),
  );
  const out = await d.llm.json("extraction", req).catch(async (e: unknown) => {
    // Invalid output after the client's retry is final: stop showing it as being read.
    if ((e as { retryable?: unknown }).retryable === false) await markLiError(d.pool, post.id);
    throw e;
  });
  const gate = liCardGate(out.data);
  await withTransaction(d.pool, async (c) => {
    const commenters = await saveLiRead(c, post.id, out.data, post.comments, gate.ok ? "checking" : gate.outcome);
    if (gate.ok) await d.send(Q.cardLiPost, { liPostId: post.id } satisfies CardLiPost, undefined, c);
    for (const liCommentId of commenters) await d.send(Q.cardLiComment, { liCommentId } satisfies CardLiComment, undefined, c);
  });
  const shared = out.data.comments.filter((k) => k.resonates).length;
  return out.data.has_pain ? `pain: ${out.data.pains.length}, ${shared} comments share it, card: ${gate.ok ? "checking" : gate.outcome}` : "no pain";
}

// A kept pain post becomes a card on the same path as a job post (fit → size → resolve → card).
// The read's author check stands; this call only fills the card. A post already carded (found
// by another topic, or by the Google digest before it) costs no second call.
export async function cardLiPost(d: Deps, job: CardLiPost): Promise<string> {
  const p = await liPostForCard(d.pool, job.liPostId);
  if (!p) return "post gone";
  if (p.cardOutcome !== "checking") return "already decided";
  const gate = liCardGate({
    has_pain: !!p.hasPain,
    author_relation: p.authorRelation as LiRead["author_relation"],
    stance: p.stance as LiRead["stance"],
    author_company: p.authorCompany,
    author_country: (p.authorCountry ?? "unknown") as LiRead["author_country"],
  });
  const setOutcome = (o: LiCardOutcome) => setLiCardOutcome(d.pool, p.id, o);
  if (!gate.ok) return setOutcome(gate.outcome).then(() => gate.outcome);
  return cardFromLinkedin(d, {
    naturalId: `post:linkedin:${p.postId}`,
    setOutcome,
    request: buildLiCardExtraction({ text: p.body, authorHeadline: p.authorHeadline, company: gate.company, authorRelation: p.authorRelation!, stance: p.stance! }),
    relation: p.authorRelation as AuthorRelation,
    stance: p.stance as StructuredIntelligence["stance"],
    text: p.body,
    url: p.url,
    title: "LinkedIn post",
    postedAt: p.postedAt,
    runId: p.runId,
    vertical: p.vertical,
    company: gate.company,
    country: gate.country,
  });
}

// What a post and a comment share once their gate has passed (§4.1d): no second AI call for one
// already carded; the card call (a final failure recorded on the row); the read's verdict on the
// author wins over the card call's copy of it; solved with software pitches Company OS (§1.1);
// then the job-post path to a card (fit, size, resolve, card) and its outcome recorded.
async function cardFromLinkedin(
  d: Deps,
  x: {
    naturalId: string;
    setOutcome: (o: LiCardOutcome) => Promise<void>;
    request: ReturnType<typeof buildLiCardExtraction>;
    relation: AuthorRelation;
    stance: StructuredIntelligence["stance"];
    text: string;
    url: string;
    title: string;
    postedAt: Date | null;
    runId: string;
    vertical: string | null;
    company: string;
    country: "in" | "ae" | "us";
  },
): Promise<string> {
  if (await challengeExists(d.pool, x.naturalId)) {
    await x.setOutcome("duplicate");
    return "duplicate";
  }
  const out = await d.llm.json("extraction", x.request).catch(async (e: unknown) => {
    if ((e as { retryable?: unknown }).retryable === false) await x.setOutcome("ai_error");
    throw e;
  });
  const { vertical, ...extracted } = out.data;
  const si: StructuredIntelligence = { ...extracted, author_relation: x.relation, stance: x.stance };
  const rest = si.stance === "solved" && si.solved_how === "with_software" ? { ...si, product_layer: "company_os" as const } : si;
  const text = x.text.slice(0, 2000);
  const v = (vertical ?? x.vertical) as VerticalSlug | null;
  const gated = gateSnippet(text, v);
  const asPost: ExtractLlm = {
    runId: x.runId,
    vertical: v,
    founderDependency: gated.pass && gated.founderDependency,
    source: "linkedin_post",
    author: x.relation,
    post: {
      naturalId: x.naturalId,
      url: x.url,
      title: x.title,
      company: x.company,
      description: text,
      postedAt: x.postedAt?.toISOString() ?? null,
      city: null,
      country: x.country,
      boardWebsite: null,
      boardEmployeeBand: null,
    },
  };
  const result = await toCard(d, asPost, rest, out.model);
  await x.setOutcome(result === "dropped_no_fit_count" ? "no_fit" : result === "dropped_size_count" ? "too_large" : "card");
  return result;
}

// A commenter's own card (operator's choice, 2026-11-08: green or yellow comments). The comment
// is the evidence and the post is context; shares counts as suffering, another perspective as
// implied (lower intent). Same path to a card as a post.
const REPLY_STANCE = { shares: "suffering", perspective: "implied" } as const;

export async function cardLiComment(d: Deps, job: CardLiComment): Promise<string> {
  const k = await liCommentForCard(d.pool, job.liCommentId);
  if (!k) return "comment gone";
  if (k.cardOutcome !== "checking") return "already decided";
  const gate = liCommentCardGate({
    reply_kind: k.replyKind ?? "unhelpful",
    relation: k.relation as LiRead["author_relation"],
    company: k.company,
    country: (k.country ?? "unknown") as LiRead["author_country"],
  });
  const setOutcome = (o: LiCardOutcome) => setLiCommentCardOutcome(d.pool, k.id, o);
  if (!gate.ok) return setOutcome(gate.outcome).then(() => gate.outcome);
  const stance = REPLY_STANCE[k.replyKind === "shares" ? "shares" : "perspective"]; // the gate let only these two through
  return cardFromLinkedin(d, {
    naturalId: `comment:linkedin:${k.commentId}`,
    setOutcome,
    request: buildLiCardExtraction({ text: k.body, authorHeadline: k.headline, company: gate.company, authorRelation: k.relation!, stance, replyTo: k.postBody }),
    relation: k.relation as AuthorRelation,
    stance,
    text: k.body,
    url: k.url ?? k.postUrl,
    title: "LinkedIn comment",
    postedAt: k.commentedAt ?? k.postedAt,
    runId: k.runId,
    vertical: k.vertical,
    company: gate.company,
    country: gate.country,
  });
}
