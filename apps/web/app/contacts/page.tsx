// /contacts (operator's request, 2026-11-09; a separate screen to try out, nothing else changed):
// describe who you are and who you want; get people from LinkedIn posts and comments with a match
// %, their profile link, and the pains they shared that fit. Each search is one click, about a cent.
import Link from "next/link";
import { ArrowLeft } from "@phosphor-icons/react/ssr";
import { ContactBoard } from "@/components/ContactBoard.tsx";
import { ContactSearchForm } from "@/components/ContactSearchForm.tsx";
import { AutoRefresh } from "@/components/RunNow.tsx";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { ageLabel } from "@/lib/labels.ts";
import { loadContacts } from "@/lib/contacts.ts";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).s;
  const { searches, current } = await loadContacts(typeof raw === "string" && UUID.test(raw) ? raw : null);
  return (
    <div className="radar">
      <header className="radar-head">
        <Link href="/dashboard" className="radar-back">
          <ArrowLeft size={16} aria-hidden /> Inbox
        </Link>
        <h1>Find contacts</h1>
        <ThemeToggle />
      </header>

      <main className="radar-main li-main cs-main">
        <AutoRefresh active={current?.status === "queued"} />
        <section className="cs-ask" aria-labelledby="cs-ask">
          <h2 id="cs-ask" className="sr-only">
            New search
          </h2>
          <ContactSearchForm initial={current?.query ?? ""} />
          {searches.length > 0 && (
            <nav className="cs-history" aria-label="Earlier searches">
              {searches.map((s) => (
                <Link key={s.id} href={`/contacts?s=${s.id}`} className={`trend-chip${s.id === current?.id ? " is-current" : ""}`} aria-current={s.id === current?.id ? "true" : undefined} title={s.query}>
                  {s.query.length > 48 ? `${s.query.slice(0, 47)}…` : s.query}
                  <span className="num">{s.status === "queued" ? "…" : s.status === "error" ? "!" : s.found}</span>
                </Link>
              ))}
            </nav>
          )}
        </section>

        {!current && <p className="muted">Each search reads the pain already found in LinkedIn posts and comments. It costs about a cent and starts no new scraping.</p>}
        {current?.status === "queued" && (
          <p className="muted" role="status">
            Finding people for “{current.query}”: usually under 30 seconds.
          </p>
        )}
        {current?.status === "error" && <p className="run-result is-error">The search failed: {current.error}. Try it again.</p>}
        {current?.status === "done" && (
          <>
            <p className="li-cell-sub cs-summary">
              {current.plan?.seeking === "providers" ? "Looking for people with the skill" : "Looking for people with the problem"}
              {current.plan?.icp && `: ${current.plan.icp}`}. {current.results.length} of {current.candidates ?? 0} people matched, searched {ageLabel(current.requested_at)}
              {current.cost_usd !== null && `, $${current.cost_usd.toFixed(4)}`}.
            </p>
            {current.results.length === 0 ? (
              <p className="muted">Nobody in the posts read so far fits this. A LinkedIn search on this topic would find more.</p>
            ) : (
              <ContactBoard key={current.id} results={current.results} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
