"use client";
// Contacts tab of LinkedIn post search (PRD §4.1d), three columns (operator's layout, 2026-11-08):
// posts in two lines | the chosen post in full, then its commenters ranked by pain score, each
// followed by their comments, in one scrolling flow with no boxes | the post authors, with and
// without pain. Each column scrolls on its own.
import { useRef, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react/ssr";
import { ContactFacts, Person, ROLE, Verdict, excerpt, https, plural } from "@/components/LiParts.tsx";
import { ageLabel } from "@/lib/labels.ts";
import type { LiCommentRow, LiPostRow } from "@/lib/linkedin.ts";

const URGENCY_LABEL = { none: "No pain of their own", nuisance: "Nuisance", recurring: "Recurring", blocking: "Blocking" } as const;
const SIGNAL_LABEL: Record<string, string> = {
  own_experience: "Their own experience",
  specifics: "Specifics: numbers, hours, money or tools",
  current_process: "How they handle it today",
  consequence: "The impact on them",
};
const SIGNAL_POINTS: Record<string, number> = { own_experience: 35, specifics: 25, current_process: 25, consequence: 15 };

// One commenter on one post, with every comment they left there.
interface Person {
  key: string;
  name: string;
  headline: string | null;
  company: string | null;
  profileUrl: string | null;
  type: string;
  sharing: boolean;
  emails: string[];
  comments: LiCommentRow[]; // best scored first
  best: LiCommentRow;
}

function people(p: LiPostRow): Person[] {
  const by = new Map<string, Person>();
  for (const k of p.comments) {
    const key = k.profile_url ?? k.name ?? k.id;
    const had = by.get(key);
    if (had) {
      had.comments.push(k);
      had.sharing ||= !!k.resonates;
      had.emails = [...new Set([...had.emails, ...k.emails])];
      if ((k.pain_score ?? -1) > (had.best.pain_score ?? -1)) had.best = k;
    } else
      by.set(key, {
        key,
        name: k.name ?? (k.actor_type === "company" ? "Company page" : "LinkedIn member"),
        headline: k.headline && /\w/.test(k.headline) ? k.headline : null,
        company: k.company,
        profileUrl: https(k.profile_url),
        type: k.actor_type,
        sharing: !!k.resonates,
        emails: k.emails,
        comments: [k],
        best: k,
      });
  }
  for (const x of by.values()) x.comments.sort((a, b) => (b.pain_score ?? -1) - (a.pain_score ?? -1));
  return [...by.values()].sort((a, b) => (b.best.pain_score ?? -1) - (a.best.pain_score ?? -1));
}

const level = (score: number | null) => (score === null ? "none" : score >= 60 ? "high" : score >= 30 ? "mid" : "low");

export function LiContactsBoard({ posts }: { posts: LiPostRow[] }) {
  const [postId, setPostId] = useState(() => (posts.find((p) => p.has_pain) ?? posts[0])?.id ?? null);
  const detail = useRef<HTMLElement>(null);
  const post = posts.find((p) => p.id === postId) ?? posts[0] ?? null;
  if (!post) return <p className="muted social-empty">No posts in this search.</p>;
  const ranked = people(post);
  const sharing = ranked.filter((x) => x.sharing).length;
  const withPain = posts.filter((p) => p.has_pain);
  const noPain = posts.filter((p) => !p.has_pain);

  const choosePost = (id: string) => {
    setPostId(id);
    const el = detail.current;
    if (!el) return;
    el.scrollTop = 0; // a new post starts at its top
    // Stacked (a phone), the post sits below the list: bring it into view.
    if (getComputedStyle(el.parentElement!).gridTemplateColumns.split(" ").length === 1) el.scrollIntoView({ block: "start" });
  };

  return (
    <div className="li-kanban">
      <section className="li-col" aria-label="Posts">
        <PostCards title="With pain" posts={withPain} selectedId={post.id} onChoose={choosePost} empty="No post shows a pain point, challenge or problem." />
        {noPain.length > 0 && <PostCards title="No pain found" posts={noPain} selectedId={post.id} onChoose={choosePost} />}
      </section>

      <section className="li-col li-k-detail" aria-label="The selected post and its commenters" ref={detail}>
        <div className="li-k-post">
          <span className="lead-head">
            <Verdict p={post} />
          </span>
          {post.pains.length > 0 && (
            <ul className="li-pains" aria-label="Problems in this post">
              {post.pains.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          <p className="li-body li-k-body">{post.body}</p>
          <a href={post.url} target="_blank" rel="noopener noreferrer" className="link post-open">
            Open on LinkedIn <ArrowSquareOut size={13} aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>

        <h3 className="li-col-title">
          Commenters <span className="num">{ranked.length}</span>
          {sharing > 0 && <span className="li-col-note">{sharing} sharing the pain</span>}
          {ranked.length > 1 && <span className="li-col-note-plain">ranked by pain score</span>}
        </h3>
        {ranked.length === 0 && <p className="muted li-col-empty">No comments collected for this post.</p>}
        {ranked.map((x) => (
          <div key={x.key} className="li-k-commenter">
            <span className="li-card-row">
              {x.profileUrl ? (
                <a href={x.profileUrl} target="_blank" rel="noopener noreferrer" className="link li-name">
                  {x.name}
                  <span className="sr-only"> (LinkedIn profile, opens in a new tab)</span>
                </a>
              ) : (
                <span className="li-name">{x.name}</span>
              )}
              <Score value={x.best.pain_score} />
            </span>
            {x.sharing && <span className="li-share">Shares the pain</span>}
            <ContactFacts headline={x.headline} company={x.company} emails={x.emails} />
            {x.comments.map((k) => (
              <CommentScore key={k.id} k={k} />
            ))}
          </div>
        ))}
      </section>

      <section className="li-col" aria-label="Post authors">
        <AuthorList title="Post authors, pain found" posts={withPain} selectedId={post.id} onChoose={choosePost} />
        <AuthorList title="Post authors, no pain found" posts={noPain} selectedId={post.id} onChoose={choosePost} />
      </section>
    </div>
  );
}

// Every post's author; the selected post's author is marked, and choosing one shows their post.
function AuthorList({ title, posts, selectedId, onChoose }: { title: string; posts: LiPostRow[]; selectedId: string; onChoose: (id: string) => void }) {
  return (
    <>
      <h3 className="li-col-title">
        {title} <span className="num">{posts.length}</span>
      </h3>
      {posts.length === 0 && <p className="muted li-col-empty">None.</p>}
      <ul className="li-k-authors">
        {posts.map((p) => (
          <li key={p.id} className={p.id === selectedId ? "is-selected" : undefined} aria-current={p.id === selectedId ? "true" : undefined}>
            <span className="li-card-row">
              <Person name={p.author_name} url={p.author_url} type={p.author_type} />
              {p.author_relation && <span className="verdict">{ROLE[p.author_relation] ?? p.author_relation}</span>}
            </span>
            <ContactFacts headline={p.author_headline} company={p.author_company} emails={p.emails} website={p.author_website} />
            {p.id !== selectedId && (
              <button type="button" className="link li-k-show" onClick={() => onChoose(p.id)}>
                Show their post
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function PostCards({ title, posts, selectedId, onChoose, empty }: { title: string; posts: LiPostRow[]; selectedId: string; onChoose: (id: string) => void; empty?: string }) {
  return (
    <>
      <h3 className="li-col-title">
        {title} <span className="num">{posts.length}</span>
      </h3>
      {posts.length === 0 && empty && <p className="muted li-col-empty">{empty}</p>}
      <ul className="li-cards">
        {posts.map((p) => {
          const sharing = p.comments.filter((k) => k.resonates).length;
          return (
            <li key={p.id}>
              <button type="button" className="li-card" aria-pressed={p.id === selectedId} onClick={() => onChoose(p.id)}>
                <span className="li-card-title li-two-lines">{excerpt(p.body, 160)}</span>
                <span className="li-card-meta">
                  {p.author_name ?? (p.author_type === "company" ? "Company page" : "LinkedIn member")}
                  {p.author_relation && `, ${ROLE[p.author_relation]?.toLowerCase() ?? p.author_relation}`}
                </span>
                <span className="li-card-meta">
                  {plural(p.comments.length, "commenter", "commenters")}
                  {sharing > 0 && `, ${sharing} sharing`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Score({ value }: { value: number | null }) {
  return (
    <span className={`li-score li-score-${level(value)}`} title="Pain score: 60% urgency + 40% depth">
      {value === null ? "Not scored" : <span className="num">{value}</span>}
    </span>
  );
}

// One comment: its score and how it was reached, as plain lines (no box), then what is critical in
// it and the comment itself.
function CommentScore({ k }: { k: LiCommentRow }) {
  const on = Object.keys(SIGNAL_LABEL).filter((s) => k.signals.includes(s));
  return (
    <article className="li-comment">
      <p className="li-k-score">
        <Score value={k.pain_score} />
        <span>
          Urgency <span className="num">{k.urgency_pct ?? 0}%</span> ({k.urgency ? URGENCY_LABEL[k.urgency].toLowerCase() : "not read"}), depth{" "}
          <span className="num">{k.depth_pct ?? 0}%</span>
          {on.length > 0 && <>: {on.map((s) => `${SIGNAL_LABEL[s]!.split(":")[0]!.toLowerCase()} +${SIGNAL_POINTS[s]}`).join(", ")}</>}
          {!k.resonates && k.pain_score === 30 && ". Not sharing the pain, so capped at 30"}
        </span>
      </p>
      {k.gist && (
        <p className="li-gist">
          <strong>Critical point:</strong> {k.gist}
        </p>
      )}
      <p className="li-body li-k-text">{k.body}</p>
      <span className="li-cell-sub">
        {k.commented_at ? `Commented ${ageLabel(k.commented_at)}` : "Date not recorded"}, {plural(k.likes, "like", "likes")}
        {k.url && (
          <>
            {", "}
            <a href={k.url} target="_blank" rel="noopener noreferrer" className="link">
              Open the comment<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </>
        )}
      </span>
    </article>
  );
}
