"use client";
// Contacts tab of LinkedIn post search (PRD §4.1d) as a kanban, each column scrolling on its own:
// posts | the post | post authors (with and without pain) | its commenters, ranked by pain score |
// the chosen commenter's comments with how their score was reached.
import { useMemo, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react/ssr";
import { ROLE, Verdict, excerpt, https, plural } from "@/components/LiParts.tsx";
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
  const post = posts.find((p) => p.id === postId) ?? posts[0] ?? null;
  const ranked = useMemo(() => (post ? people(post) : []), [post]);
  const [personKey, setPersonKey] = useState<string | null>(null);
  const person = ranked.find((x) => x.key === personKey) ?? ranked[0] ?? null;

  const choosePost = (id: string) => {
    setPostId(id);
    setPersonKey(null); // the new post's top-ranked commenter
    for (const col of document.querySelectorAll<HTMLElement>(".li-kanban .li-k-reset")) col.scrollTop = 0;
  };
  if (!post) return <p className="muted social-empty">No posts in this search.</p>;
  const withPain = posts.filter((p) => p.has_pain);
  const noPain = posts.filter((p) => !p.has_pain);

  return (
    <div className="li-kanban">
      <section className="li-col" aria-label="Posts">
        <h3 className="li-col-title">
          Posts <span className="num">{posts.length}</span>
        </h3>
        <ul className="li-cards">
          {posts.map((p) => (
            <li key={p.id}>
              <button type="button" className="li-card" aria-pressed={p.id === post.id} onClick={() => choosePost(p.id)}>
                <span className="li-card-title li-two-lines">{excerpt(p.body, 160)}</span>
                <span className="li-card-meta">
                  {p.has_pain ? "Pain found" : "No pain found"}, {plural(p.comments.length, "commenter", "commenters")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="li-col li-k-reset" aria-label="The selected post">
        <h3 className="li-col-title">Post</h3>
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
        <p className="li-body li-k-text">{post.body}</p>
        <a href={post.url} target="_blank" rel="noopener noreferrer" className="link post-open">
          Open on LinkedIn <ArrowSquareOut size={13} aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </section>

      <section className="li-col" aria-label="Post authors">
        <h3 className="li-col-title">
          Post authors, pain found <span className="num">{withPain.length}</span>
        </h3>
        <AuthorCards posts={withPain} selectedId={post.id} onChoose={choosePost} />
        <h3 className="li-col-title">
          Post authors, no pain found <span className="num">{noPain.length}</span>
        </h3>
        <AuthorCards posts={noPain} selectedId={post.id} onChoose={choosePost} />
      </section>

      <section className="li-col li-k-reset" aria-label="Commenters on the selected post">
        <h3 className="li-col-title">
          Commenters <span className="num">{ranked.length}</span>
          <span className="li-col-note-plain">ranked by pain score</span>
        </h3>
        {ranked.length === 0 && <p className="muted li-col-empty">No comments collected for this post.</p>}
        <ul className="li-cards">
          {ranked.map((x) => (
            <li key={x.key} className="li-card-wrap">
              <button type="button" className={`li-card${x.sharing ? " is-sharing" : ""}`} aria-pressed={x.key === person?.key} onClick={() => setPersonKey(x.key)}>
                <span className="li-card-row">
                  <span className="li-card-title">{x.name}</span>
                  <Score value={x.best.pain_score} />
                </span>
                {x.headline && <span className="li-card-meta li-two-lines">{x.headline}</span>}
                {x.sharing && <span className="li-share">Shares the pain</span>}
              </button>
              {x.profileUrl && (
                <a href={x.profileUrl} target="_blank" rel="noopener noreferrer" className="link li-card-link">
                  LinkedIn profile <ArrowSquareOut size={12} aria-hidden />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="li-col li-k-reset" aria-label="Comments of the selected commenter">
        <h3 className="li-col-title">Comments</h3>
        {!person ? (
          <p className="muted li-col-empty">Pick a commenter to read their comments.</p>
        ) : (
          <>
            <div className="li-person">
              {person.profileUrl ? (
                <a href={person.profileUrl} target="_blank" rel="noopener noreferrer" className="link li-name">
                  {person.name}
                  <span className="sr-only"> (LinkedIn profile, opens in a new tab)</span>
                </a>
              ) : (
                <span className="li-name">{person.name}</span>
              )}
              {person.headline && <span className="li-headline">{person.headline}</span>}
              {person.company && <span className="li-cell-sub">Company: {person.company}</span>}
              {person.emails.map((e) => (
                <a key={e} href={`mailto:${e}`} className="link li-cell-sub">
                  {e}
                </a>
              ))}
            </div>
            {person.comments.map((k) => (
              <CommentScore key={k.id} k={k} />
            ))}
          </>
        )}
      </section>
    </div>
  );
}

function AuthorCards({ posts, selectedId, onChoose }: { posts: LiPostRow[]; selectedId: string; onChoose: (id: string) => void }) {
  if (!posts.length) return <p className="muted li-col-empty">None.</p>;
  return (
    <ul className="li-cards">
      {posts.map((p) => {
        const url = https(p.author_url);
        const role = [p.author_relation && ROLE[p.author_relation], p.author_company].filter(Boolean).join(", ");
        return (
          <li key={p.id} className="li-card-wrap">
            <button type="button" className="li-card" aria-pressed={p.id === selectedId} onClick={() => onChoose(p.id)}>
              <span className="li-card-title">{p.author_name ?? (p.author_type === "company" ? "Company page" : "LinkedIn member")}</span>
              {role && <span className="li-card-meta">{role}</span>}
              <span className="li-card-meta li-two-lines">{excerpt(p.body, 100)}</span>
            </button>
            {url && (
              <a href={url} target="_blank" rel="noopener noreferrer" className="link li-card-link">
                LinkedIn profile <ArrowSquareOut size={12} aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Score({ value }: { value: number | null }) {
  return (
    <span className={`li-score li-score-${level(value)}`} title="Pain score: 60% urgency + 40% depth">
      {value === null ? "Not scored" : <span className="num">{value}</span>}
    </span>
  );
}

function CommentScore({ k }: { k: LiCommentRow }) {
  return (
    <article className="li-comment">
      <div className="li-scorebox" aria-label="How this comment was scored">
        <div className="li-scorebox-main">
          <span className="li-cell-sub">Pain score</span>
          <Score value={k.pain_score} />
        </div>
        <dl className="li-scorebox-parts">
          <div>
            <dt>Urgency</dt>
            <dd>
              <span className="num">{k.urgency_pct ?? 0}%</span> {k.urgency ? URGENCY_LABEL[k.urgency] : "Not read"}
            </dd>
          </div>
          <div>
            <dt>Depth</dt>
            <dd>
              <span className="num">{k.depth_pct ?? 0}%</span>
            </dd>
          </div>
        </dl>
        <ul className="li-signals" aria-label="What the comment shows">
          {Object.keys(SIGNAL_LABEL).map((s) => (
            <li key={s} className={k.signals.includes(s) ? "is-on" : undefined}>
              {SIGNAL_LABEL[s]} <span className="num">{k.signals.includes(s) ? `+${SIGNAL_POINTS[s]}` : "0"}</span>
            </li>
          ))}
        </ul>
        {!k.resonates && k.pain_score !== null && <p className="li-cell-sub">Not sharing the pain, so capped at 30.</p>}
      </div>
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
