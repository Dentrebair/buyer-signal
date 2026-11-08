// LinkedIn post search (PRD §4.1d): run a topic, then read one run in three tabs: Search (every
// post found), Posts (the pains each post shows, posts with pain first) and Contacts (each post's
// author and commenters, with what is critical in each comment). Posts and contacts link both ways.
import Link from "next/link";
import { ArrowLeft, LinkedinLogo } from "@phosphor-icons/react/ssr";
import { AutoRefresh, RunLinkedin } from "@/components/RunNow.tsx";
import { Facts, Meta } from "@/components/Meta.tsx";
import { LiBoard } from "@/components/LiBoard.tsx";
import { LiContactsBoard } from "@/components/LiContactsBoard.tsx";
import { Author, PostMeta, Verdict, excerpt } from "@/components/LiParts.tsx";
import { PostLink } from "@/components/PostLink.tsx";
import { Tabs } from "@/components/Tabs.tsx";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { ageLabel, verticalLabel } from "@/lib/labels.ts";
import { type LiPostRow, type LiRun, loadLinkedin } from "@/lib/linkedin.ts";

export const dynamic = "force-dynamic";

export default async function Linkedin({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const run = (await searchParams).run;
  const page = await loadLinkedin(typeof run === "string" ? run : null);
  const withPain = page.posts.filter((p) => p.has_pain);
  const contacts = page.posts.reduce((n, p) => n + 1 + p.comments.length, 0);
  return (
    <div className="radar">
      <AutoRefresh active={page.running} />
      <header className="radar-head">
        <Link href="/radar" className="radar-back">
          <ArrowLeft size={16} aria-hidden /> Sources
        </Link>
        <h1>LinkedIn post search</h1>
        <ThemeToggle />
      </header>

      <main className="radar-main li-main">
        <section className="card source" aria-labelledby="li-run">
          <div className="source-head">
            <h2 id="li-run">
              <LinkedinLogo size={18} aria-hidden /> Search LinkedIn posts
            </h2>
            <Meta className="source-meta" items={["Full posts with their comments", "Last 21 days"]} />
          </div>
          <RunLinkedin />
          <p className="muted source-note">
            Searches LinkedIn for a topic. The AI reads each post for pain points, challenges and problems, stated or implied, and reads the comments
            for people sharing the same pain. A pain post by the business&apos;s own people, with its company named and in one of our markets,
            becomes an inbox card. Names, headlines and profile links only: no profile visits and no email lookups.
          </p>
          {page.runs.length > 0 ? <LiRuns runs={page.runs} shownId={page.shown?.id ?? null} /> : <p className="muted">No runs yet.</p>}
        </section>

        {page.shown && (
          <section className="li-results" aria-labelledby="li-results-h">
            <h2 id="li-results-h" className="li-results-title">
              “{page.shown.topic}”
            </h2>
            <Meta
              className="source-meta"
              items={[
                `Started ${ageLabel(page.shown.started_at)}`,
                page.shown.vertical && verticalLabel(page.shown.vertical),
                page.shown.reading > 0 && `The AI is still reading ${page.shown.reading} ${page.shown.reading === 1 ? "post" : "posts"}`,
              ]}
            />
            {page.posts.length === 0 ? (
              <p className="muted">{["starting", "running", "fetching"].includes(page.shown.status) ? "Searching LinkedIn…" : "No posts from the last 21 days."}</p>
            ) : (
              <Tabs
                label="Results of this search"
                tabs={[
                  { id: "search", label: "Search", count: page.posts.length, content: <SearchTab posts={page.posts} /> },
                  { id: "posts", label: "Posts", count: withPain.length, content: <LiBoard posts={page.posts} /> },
                  { id: "contacts", label: "Contacts", count: contacts, content: <LiContactsBoard posts={page.posts} /> },
                ]}
              />
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function LiRuns({ runs, shownId }: { runs: LiRun[]; shownId: string | null }) {
  return (
    <div className="runs-wrap">
      <table className="runs">
        <caption className="sr-only">Latest LinkedIn post searches</caption>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Topic</th>
            <th scope="col" className="r">
              Posts
            </th>
            <th scope="col" className="r">
              With pain
            </th>
            <th scope="col" className="r">
              Cards
            </th>
            <th scope="col" className="r">
              Contacts
            </th>
            <th scope="col" className="r">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className={r.id === shownId ? "is-shown" : undefined}>
              <td>{ageLabel(r.started_at)}</td>
              <td>
                <Link href={`/linkedin?run=${r.id}`} className="link run-search" aria-current={r.id === shownId ? "true" : undefined}>
                  “{r.topic}”
                </Link>
                <Facts items={[["vertical", r.vertical && verticalLabel(r.vertical)]]} />
              </td>
              <td className="r num">{r.status === "failed" ? "Failed" : ["starting", "running", "fetching"].includes(r.status) ? "Searching" : r.posts}</td>
              <td className="r num">{r.pain}</td>
              <td className="r num">{r.cards}</td>
              <td className="r num">{r.contacts}</td>
              <td className="r num">${r.cost_usd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Search: every post the search returned, as LinkedIn showed it.
function SearchTab({ posts }: { posts: LiPostRow[] }) {
  return (
    <ul className="social-list">
      {posts.map((p) => (
        <li key={p.id} className="social-item ev-social li-post">
          <PostLink url={p.url} sourceType="linkedin_post" id={`ls-${p.id}`} />
          <Author p={p} />
          <PostMeta p={p} />
          <p className="li-preview">{excerpt(p.body, 280)}</p>
          <span className="lead-head">
            <Verdict p={p} />
            {p.has_pain && (
              <a href={`#post-${p.id}`} className="link post-open">
                See the pains
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
