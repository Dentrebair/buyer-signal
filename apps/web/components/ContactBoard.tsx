"use client";
// /contacts results: matched people, best first, with their match % | the chosen person: profile
// link, why they fit, their pain in short points, and what they actually wrote, linked.
import { useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import type { ContactMatch } from "@bs/core/contactMatch";
import { https } from "@/components/LiParts.tsx";

const ROLE: Record<ContactMatch["role"], string> = { author: "Post author", commenter: "Commenter", both: "Author and commenter" };
const SOURCE: Record<ContactMatch["sources"][number]["source"], string> = { own_post: "Their post", comment: "Their comment" };
const band = (m: number) => (m >= 75 ? "is-high" : m >= 50 ? "is-mid" : "is-low");

export function ContactBoard({ results }: { results: ContactMatch[] }) {
  const [chosen, setChosen] = useState(0);
  const c = results[Math.min(chosen, results.length - 1)]!;
  const profile = https(c.profileUrl);
  return (
    <div className="cs-board">
      <section className="li-col" aria-labelledby="cs-people">
        <h2 id="cs-people" className="li-col-title">
          Contacts <span className="num">{results.length}</span>
        </h2>
        <ol className="li-cards">
          {results.map((r, i) => (
            <li key={r.key}>
              <button type="button" className="li-card cs-card" aria-pressed={i === chosen} onClick={() => setChosen(i)}>
                <span className="cs-card-head">
                  <span className="li-card-title">{r.name}</span>
                  <span className={`cs-match num ${band(r.match)}`}>{r.match}%</span>
                </span>
                {r.headline && <span className="cs-card-sub">{r.headline}</span>}
                <span className="li-card-meta">{ROLE[r.role]}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      <section className="li-col cs-detail" aria-labelledby="cs-person">
        <h2 id="cs-person" className="li-col-title">
          Contact
        </h2>
        <div className="cs-person">
          <div className="cs-person-head">
            <p className="cs-name">{c.name}</p>
            <span className={`cs-match cs-match-lg num ${band(c.match)}`}>{c.match}% match</span>
          </div>
          {c.headline && <p className="li-headline">{c.headline}</p>}
          <p className="li-cell-sub">
            {ROLE[c.role]}
            {c.company && `, ${c.company}`}
          </p>
          {profile ? (
            <a href={profile} target="_blank" rel="noopener noreferrer" className="btn btn-sm cs-profile">
              <ArrowSquareOut size={14} aria-hidden /> LinkedIn profile
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <p className="li-cell-sub">No profile link was shared.</p>
          )}
          <p className="cs-why">{c.why}</p>
        </div>

        <h3 className="li-col-title">Pain points</h3>
        <ul className="li-pains">
          {c.points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>

        <h3 className="li-col-title">What they wrote</h3>
        <ul className="li-cell-list">
          {c.sources.map((s, i) => {
            const href = https(s.url);
            return (
              <li key={i} className={s.source === "comment" ? "is-sharing" : undefined}>
                <span className="li-share">{SOURCE[s.source]}</span>
                <span className="li-cell-gist">{s.text}</span>
                {href && (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="link li-cell-sub">
                    Open on LinkedIn<span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
