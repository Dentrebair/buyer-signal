// Pieces of a LinkedIn post search result (PRD §4.1d) shared by the server page and the Posts
// board (a client component): no hooks, no server-only imports.
import { ArrowSquareOut } from "@phosphor-icons/react/ssr";
import { Meta } from "@/components/Meta.tsx";
import { ageLabel } from "@/lib/labels.ts";
import type { LiCommentRow, LiPostRow } from "@/lib/linkedin.ts";

export const ROLE: Record<string, string> = {
  founder_owner: "Founder or owner",
  employee: "Employee",
  company_page: "Company page",
  former_employee: "Former employee",
  vendor: "Vendor",
  commentator: "Commentator",
  recruiter: "Recruiter",
};
export const STANCE: Record<string, string> = {
  suffering: "has the problem",
  implied: "shows manual work",
  solved: "solved it",
  selling: "selling",
  commenting: "commenting",
};
export const https = (u: string | null) => (u && /^https:\/\//i.test(u) ? u : null);
// One paragraph, cut at a word: previews ignore the post's own line breaks.
export const excerpt = (raw: string, n: number) => {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, s.lastIndexOf(" ", n) > 0 ? s.lastIndexOf(" ", n) : n)}…` : s;
};
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function Author({ p }: { p: LiPostRow }) {
  const url = https(p.author_url);
  const name = p.author_name ?? (p.author_type === "company" ? "Company page" : "LinkedIn member");
  return (
    <div className="li-author">
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="link li-name">
          {name}
          <span className="sr-only"> (LinkedIn profile, opens in a new tab)</span>
        </a>
      ) : (
        <span className="li-name">{name}</span>
      )}
      {p.author_headline && <span className="li-headline">{p.author_headline}</span>}
    </div>
  );
}

export function PostMeta({ p }: { p: LiPostRow }) {
  return (
    <Meta
      className="li-meta"
      items={[
        p.posted_at && `Posted ${ageLabel(p.posted_at)}`,
        plural(p.likes, "like", "likes"),
        plural(p.comment_count, "comment", "comments"),
      ]}
    />
  );
}

// Why a pain post did not become an inbox card (li_posts.card_outcome, §4.1d).
const NOT_A_CARD: Record<string, string> = {
  not_own: "not the business's own pain",
  no_company: "no company named",
  no_market: "outside our markets",
  duplicate: "already a card from another search",
  no_fit: "nothing to automate",
  too_large: "company too large",
  ai_error: "the AI couldn't fill the card",
};

export function Verdict({ p }: { p: LiPostRow }) {
  if (p.status === "reading") return <span className="verdict">The AI is reading it</span>;
  if (p.status === "ai_error") return <span className="verdict">The AI couldn&apos;t read it</span>;
  return (
    <>
      {p.has_pain ? <span className="verdict verdict-green">Pain found</span> : <span className="verdict">No pain found</span>}
      {p.author_relation && (
        <span className="verdict">
          {ROLE[p.author_relation] ?? p.author_relation}
          {p.stance && `, ${STANCE[p.stance] ?? p.stance}`}
        </span>
      )}
      {p.has_pain && <InboxStatus p={p} />}
    </>
  );
}

function InboxStatus({ p }: { p: LiPostRow }) {
  if (p.card_outcome === "checking") return <span className="verdict">Checking for a card</span>;
  if (p.card_company_id && (p.card_outcome === "card" || p.card_outcome === "duplicate"))
    return (
      <a href={`/dashboard?id=${p.card_company_id}`} className="verdict verdict-green link">
        In the inbox
      </a>
    );
  const why = p.card_outcome ? NOT_A_CARD[p.card_outcome] : null;
  return why ? <span className="verdict">Not a card: {why}</span> : null;
}

export function PostLinks({ p }: { p: LiPostRow }) {
  return (
    <span className="li-group-links">
      <a href={`#post-${p.id}`} className="link post-open">
        View post
      </a>
      <a href={p.url} target="_blank" rel="noopener noreferrer" className="link post-open">
        On LinkedIn <ArrowSquareOut size={13} aria-hidden />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
      {p.has_pain && <span className="verdict verdict-green">Pain found</span>}
    </span>
  );
}

export const firstLine = (p: LiPostRow) => excerpt(p.body.split("\n").find((l) => l.trim()) ?? "", 140);

export function Person({ name, url, type }: { name: string | null; url: string | null; type: string }) {
  const href = https(url);
  const label = name ?? (type === "company" ? "Company page" : "LinkedIn member");
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="link li-name">
      {label}
      <span className="sr-only"> (LinkedIn profile, opens in a new tab)</span>
    </a>
  ) : (
    <span className="li-name">{label}</span>
  );
}

export function ContactFacts({ headline, company, emails, website }: { headline: string | null; company: string | null; emails: string[]; website?: string | null }) {
  const site = website ? https(website) : null;
  return (
    <>
      {headline && /\w/.test(headline) && <span className="li-headline">{headline}</span>}
      <Meta
        className="li-meta"
        items={[
          company && <>Company: {company}</>,
          ...emails.map((e) => (
            <a key={e} href={`mailto:${e}`} className="link">
              {e}
            </a>
          )),
          site && (
            <a href={site} target="_blank" rel="noopener noreferrer" className="link">
              Website<span className="sr-only"> (opens in a new tab)</span>
            </a>
          ),
        ]}
      />
    </>
  );
}

export function Commenter({ k }: { k: LiCommentRow }) {
  return (
    <li className={`li-contact${k.resonates ? " is-sharing" : ""}`}>
      <Person name={k.name} url={k.profile_url} type={k.actor_type} />
      {k.resonates ? <span className="verdict verdict-green">Shares the pain</span> : <span className="verdict">Commenter</span>}
      <ContactFacts headline={k.headline} company={k.company} emails={k.emails} />
      {k.gist && <p className="li-gist">{k.gist}</p>}
    </li>
  );
}
