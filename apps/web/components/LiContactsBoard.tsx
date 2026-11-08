"use client";
// Contacts tab of LinkedIn post search (PRD §4.1d), operator's layout 2026-11-08. Three columns,
// each scrolling on its own under fixed section headings:
//   posts (two lines each) | the chosen post in full, then a board of its commenters and the
//   chosen commenter's comments | the authors, with and without pain.
// A comment's colour says what it does for the post's problem, always with its label in words:
// green shares the pain, yellow another perspective, red doesn't help.
import { useRef, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react/ssr";
import { ContactFacts, Person, ROLE, Verdict, excerpt, headlineOf, https, plural } from "@/components/LiParts.tsx";
import { ageLabel } from "@/lib/labels.ts";
import type { LiCommentRow, LiPostRow } from "@/lib/linkedin.ts";

type Kind = "shares" | "perspective" | "unhelpful";
const KIND_LABEL: Record<Kind, string> = { shares: "Shares the pain", perspective: "Another perspective", unhelpful: "Doesn't help" };
const KIND_RANK: Record<Kind, number> = { shares: 0, perspective: 1, unhelpful: 2 };

// Comments read before the AI gave this label (2026-11-08) get one from what it did label:
// sharing the pain is green; any depth signal (own experience, specifics…) is a perspective.
const kindOf = (k: LiCommentRow): { kind: Kind; estimated: boolean } =>
  k.reply_kind
    ? { kind: k.reply_kind, estimated: false }
    : { kind: k.resonates ? "shares" : k.signals.length ? "perspective" : "unhelpful", estimated: true };

const URGENCY_LABEL = { none: "no pain of their own", nuisance: "nuisance", recurring: "recurring", blocking: "blocking" } as const;
const SIGNAL_LABEL: Record<string, string> = {
  own_experience: "their own experience",
  specifics: "specifics",
  current_process: "how they handle it today",
  consequence: "the impact on them",
};
const SIGNAL_POINTS: Record<string, number> = { own_experience: 35, specifics: 25, current_process: 25, consequence: 15 };

// What someone is, from their headline: its first part ("Founder & CEO at Treqo | …").
const roleOf = (headline: string | null) => {
  const first = headline?.split(/\s*[|•]\s*|\n/)[0]?.trim();
  return first && /\w/.test(first) ? excerpt(first, 70) : null;
};

// One commenter on one post, with every comment they left there.
interface Commenter {
  key: string;
  name: string;
  role: string | null;
  headline: string | null;
  company: string | null;
  profileUrl: string | null;
  emails: string[];
  kind: Kind; // their most useful comment's
  comments: LiCommentRow[]; // most useful first, then by pain score
  best: number | null; // best pain score
}

function commenters(p: LiPostRow): Commenter[] {
  const by = new Map<string, Commenter>();
  for (const k of p.comments) {
    const key = k.profile_url ?? k.name ?? k.id;
    const had = by.get(key);
    const kind = kindOf(k).kind;
    if (had) {
      had.comments.push(k);
      had.emails = [...new Set([...had.emails, ...k.emails])];
      if (KIND_RANK[kind] < KIND_RANK[had.kind]) had.kind = kind;
      if ((k.pain_score ?? -1) > (had.best ?? -1)) had.best = k.pain_score;
    } else {
      const headline = headlineOf(k.headline);
      by.set(key, {
        key,
        name: k.name ?? (k.actor_type === "company" ? "Company page" : "LinkedIn member"),
        role: roleOf(headline),
        headline,
        company: k.company,
        profileUrl: https(k.profile_url),
        emails: k.emails,
        kind,
        comments: [k],
        best: k.pain_score,
      });
    }
  }
  const order = (a: LiCommentRow, b: LiCommentRow) => KIND_RANK[kindOf(a).kind] - KIND_RANK[kindOf(b).kind] || (b.pain_score ?? -1) - (a.pain_score ?? -1);
  for (const x of by.values()) x.comments.sort(order);
  return [...by.values()].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (b.best ?? -1) - (a.best ?? -1));
}

const level = (score: number | null) => (score === null ? "none" : score >= 60 ? "high" : score >= 30 ? "mid" : "low");

export function LiContactsBoard({ posts }: { posts: LiPostRow[] }) {
  const [postId, setPostId] = useState(() => (posts.find((p) => p.has_pain) ?? posts[0])?.id ?? null);
  const [personKey, setPersonKey] = useState<string | null>(null);
  const detail = useRef<HTMLElement>(null);
  const post = posts.find((p) => p.id === postId) ?? posts[0] ?? null;
  if (!post) return <p className="muted social-empty">No posts in this search.</p>;
  const list = commenters(post);
  const person = list.find((x) => x.key === personKey) ?? list[0] ?? null;
  const counts = { shares: 0, perspective: 0, unhelpful: 0 };
  for (const x of list) counts[x.kind]++;
  const withPain = posts.filter((p) => p.has_pain);
  const noPain = posts.filter((p) => !p.has_pain);

  const choosePost = (id: string) => {
    setPostId(id);
    setPersonKey(null); // the new post's first commenter
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
        <h3 className="li-col-title">Post</h3>
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

        {list.length === 0 ? (
          <>
            <h3 className="li-col-title">Commenters</h3>
            <p className="muted li-col-empty">No comments collected for this post.</p>
          </>
        ) : (
          <div className="li-k-sub">
            <div className="li-k-subcol" role="group" aria-label="Commenters">
              <h3 className="li-col-title">
                Commenters <span className="num">{list.length}</span>
              </h3>
              <p className="li-k-legend">
                {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                  <span key={k} className={`li-kind li-kind-${k}`}>
                    {KIND_LABEL[k]} <span className="num">{counts[k]}</span>
                  </span>
                ))}
              </p>
              <ul className="li-cards">
                {list.map((x) => (
                  <li key={x.key} className="li-k-person">
                    <button type="button" className={`li-card li-card-${x.kind}`} aria-pressed={x.key === person?.key} onClick={() => setPersonKey(x.key)}>
                      <span className="li-card-row">
                        <span className="li-who">
                          <span className="li-card-title">{x.name}</span>
                          {x.role && <span className="li-role">{x.role}</span>}
                        </span>
                        <Score value={x.best} />
                      </span>
                      <span className={`li-kind li-kind-${x.kind}`}>{KIND_LABEL[x.kind]}</span>
                    </button>
                    {x.profileUrl && (
                      <a href={x.profileUrl} target="_blank" rel="noopener noreferrer" className="link li-k-profile">
                        LinkedIn profile <ArrowSquareOut size={12} aria-hidden />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div className="li-k-subcol" role="group" aria-label={person ? `Comments by ${person.name}` : "Comments"}>
              <h3 className="li-col-title">Comments</h3>
              {person && (
                <>
                  <div className="li-who li-k-who">
                    <span className="li-name">{person.name}</span>
                    {person.headline && <span className="li-role">{person.headline}</span>}
                    <ContactFacts headline={null} company={person.company} emails={person.emails} />
                  </div>
                  {person.comments.map((k) => (
                    <Reply key={k.id} k={k} />
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="li-col" aria-label="Authors">
        <AuthorList title="Authors, pain found" posts={withPain} selectedId={post.id} onChoose={choosePost} />
        <AuthorList title="Authors, no pain found" posts={noPain} selectedId={post.id} onChoose={choosePost} />
      </section>
    </div>
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
        {posts.map((p) => (
          <li key={p.id}>
            <button type="button" className="li-card" aria-pressed={p.id === selectedId} onClick={() => onChoose(p.id)}>
              <span className="li-card-title li-two-lines">{excerpt(p.body, 160)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
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
            <span className="li-who">
              <Person name={p.author_name} url={p.author_url} type={p.author_type} />
              {headlineOf(p.author_headline) && <span className="li-role">{headlineOf(p.author_headline)}</span>}
            </span>
            {p.author_relation && <span className="verdict li-k-chip">{ROLE[p.author_relation] ?? p.author_relation}</span>}
            <ContactFacts headline={null} company={p.author_company} emails={p.emails} website={p.author_website} />
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

function Score({ value }: { value: number | null }) {
  return (
    <span className={`li-score li-score-${level(value)}`} title="Pain score: 60% urgency + 40% depth">
      {value === null ? "Not scored" : <span className="num">{value}</span>}
    </span>
  );
}

// One comment, coloured by what it does for the post's problem, with its label in words; then
// what is critical in it, the comment itself, and its score as one line.
function Reply({ k }: { k: LiCommentRow }) {
  const { kind, estimated } = kindOf(k);
  const on = Object.keys(SIGNAL_LABEL).filter((s) => k.signals.includes(s));
  return (
    <article className={`li-reply li-reply-${kind}`}>
      <span className={`li-kind li-kind-${kind}`} title={estimated ? "Read before this label existed: estimated from the comment's other labels" : undefined}>
        {KIND_LABEL[kind]}
        {estimated && " (estimated)"}
      </span>
      {k.gist && (
        <p className="li-gist">
          <strong>Critical point:</strong> {k.gist}
        </p>
      )}
      <p className="li-body li-k-text">{k.body}</p>
      <p className="li-k-score">
        <Score value={k.pain_score} />
        <span>
          Urgency <span className="num">{k.urgency_pct ?? 0}%</span> ({k.urgency ? URGENCY_LABEL[k.urgency] : "not read"}), depth{" "}
          <span className="num">{k.depth_pct ?? 0}%</span>
          {on.length > 0 && <>: {on.map((s) => `${SIGNAL_LABEL[s]} +${SIGNAL_POINTS[s]}`).join(", ")}</>}
          {!k.resonates && k.pain_score === 30 && ". Not sharing the pain, so capped at 30"}
        </span>
      </p>
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
