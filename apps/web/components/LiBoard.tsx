"use client";
// Posts tab of LinkedIn post search (PRD §4.1d) as a board: posts (pain first) | the selected
// post | its contacts. A link to "#post-<id>" from another tab selects that post.
import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react/ssr";
import { Author, Commenter, ContactFacts, Person, PostMeta, ROLE, Verdict, excerpt, plural } from "@/components/LiParts.tsx";
import type { LiPostRow } from "@/lib/linkedin.ts";

export function LiBoard({ posts }: { posts: LiPostRow[] }) {
  const pain = posts.filter((p) => p.has_pain);
  const rest = posts.filter((p) => !p.has_pain);
  const [selectedId, setSelectedId] = useState(() => (pain[0] ?? posts[0])?.id ?? null);
  const board = useRef<HTMLDivElement>(null);
  const selected = posts.find((p) => p.id === selectedId) ?? posts[0] ?? null;

  useEffect(() => {
    const fromHash = () => {
      const m = /^#post-([0-9a-f-]{36})$/.exec(window.location.hash);
      if (m && posts.some((p) => p.id === m[1])) setSelectedId(m[1]!);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [posts]);

  const choose = (id: string) => {
    setSelectedId(id);
    const el = board.current;
    if (!el) return;
    // A new post starts at its top in the post and contacts columns.
    for (const col of el.querySelectorAll<HTMLElement>(".li-col-post, .li-col-contacts")) col.scrollTop = 0;
    // Side by side, the board is one screen tall: keep it whole on screen. Stacked (a phone), the
    // post sits below the list: bring it into view.
    const stacked = getComputedStyle(el).gridTemplateColumns.split(" ").length === 1;
    const target = stacked ? el.querySelector(".li-col-post") : el;
    const top = target?.getBoundingClientRect().top ?? 0;
    if (top < 0 || top > window.innerHeight * 0.6) target?.scrollIntoView({ block: "start" });
  };

  if (!selected) return <p className="muted social-empty">No posts in this search.</p>;
  const sharing = selected.comments.filter((k) => k.resonates).length;
  return (
    <div className="li-board" ref={board}>
      <section className="li-col li-col-list" aria-label="Posts">
        <h3 className="li-col-title">
          With pain <span className="num">{pain.length}</span>
        </h3>
        {pain.length === 0 && <p className="muted li-col-empty">No post shows a pain point, challenge or problem.</p>}
        <PostList posts={pain} selectedId={selected.id} onChoose={choose} />
        {rest.length > 0 && (
          <>
            <h3 className="li-col-title">
              No pain found <span className="num">{rest.length}</span>
            </h3>
            <PostList posts={rest} selectedId={selected.id} onChoose={choose} />
          </>
        )}
      </section>

      <section className="li-col li-col-post" aria-label="The selected post">
        <h3 className="li-col-title">Post</h3>
        <span className="lead-head">
          <Verdict p={selected} />
        </span>
        {selected.pains.length > 0 && (
          <ul className="li-pains" aria-label="Pain points in this post">
            {selected.pains.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        <Author p={selected} />
        <PostMeta p={selected} />
        <p className="li-body">{selected.body}</p>
        <a href={selected.url} target="_blank" rel="noopener noreferrer" className="link post-open">
          Open on LinkedIn <ArrowSquareOut size={13} aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </section>

      <section className="li-col li-col-contacts" aria-label="Contacts on the selected post">
        <h3 className="li-col-title">Post author</h3>
        <ul className="li-contacts">
          <li className="li-contact">
            <Person name={selected.author_name} url={selected.author_url} type={selected.author_type} />
            {selected.author_relation && <span className="verdict">{ROLE[selected.author_relation] ?? selected.author_relation}</span>}
            <ContactFacts headline={selected.author_headline} company={selected.author_company} emails={selected.emails} website={selected.author_website} />
          </li>
        </ul>
        <h3 className="li-col-title">
          Commenters <span className="num">{selected.comments.length}</span>
          {sharing > 0 && <span className="li-col-note">{sharing} sharing the pain</span>}
        </h3>
        {selected.comments.length === 0 ? (
          <p className="muted li-col-empty">No comments collected for this post.</p>
        ) : (
          <ul className="li-contacts">
            {selected.comments.map((k) => (
              <Commenter key={k.id} k={k} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PostList({ posts, selectedId, onChoose }: { posts: LiPostRow[]; selectedId: string; onChoose: (id: string) => void }) {
  return (
    <ul className="li-cards">
      {posts.map((p) => {
        const sharing = p.comments.filter((k) => k.resonates).length;
        return (
          <li key={p.id} id={`post-${p.id}`}>
            <button type="button" className="li-card" aria-pressed={p.id === selectedId} onClick={() => onChoose(p.id)}>
              <span className="li-card-title">{p.pains[0] ?? excerpt(p.body, 90)}</span>
              <span className="li-card-meta">
                {p.author_name ?? "LinkedIn member"}
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
  );
}
