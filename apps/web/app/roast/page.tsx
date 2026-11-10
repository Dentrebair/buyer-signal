// /roast, "Roast My Stack" (PRD §8): the public page. A visitor gives their website and work
// email and gets a short teardown of what the site makes manual or hard. Their result is read by
// its id only (roast_result, migration 0029), never their email.
import type { Metadata } from "next";
import type { RoastTeardown } from "@bs/core/roast";
import { RoastForm } from "@/components/RoastForm.tsx";
import { AutoRefresh } from "@/components/RunNow.tsx";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { asRoastVisitor } from "@/lib/operator.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Roast my website", description: "A short, honest teardown of what your website makes manual or hard." };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Result {
  status: "queued" | "done" | "error";
  domain: string;
  teardown: RoastTeardown | null;
  error: string | null;
}

export default async function RoastPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).r;
  const id = typeof raw === "string" && UUID.test(raw) ? raw : null;
  const result = id ? await asRoastVisitor(async (c) => (await c.query<Result>("select status, domain, teardown, error from roast_result($1)", [id])).rows[0] ?? null) : null;
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;

  return (
    <div className="radar roast">
      <header className="radar-head">
        <p className="roast-mark">Roast my website</p>
        <ThemeToggle />
      </header>
      <main className="roast-main">
        {!result && (
          <section className="roast-hero" aria-labelledby="roast-title">
            <h1 id="roast-title">What is your website making you do by hand?</h1>
            <p className="roast-lede">Give us your site and we&apos;ll read it the way a customer and an AI assistant do, then tell you plainly what to fix first.</p>
            <RoastForm siteKey={siteKey} />
            <p className="li-cell-sub">Free. We read your public pages only. We&apos;ll use your email to follow up about the report, nothing else.</p>
          </section>
        )}

        {result?.status === "queued" && (
          <section className="roast-wait" aria-live="polite">
            <AutoRefresh active />
            <h1>Reading {result.domain}…</h1>
            <p className="roast-lede">Checking the pages, forms, booking and tools behind them. This usually takes under a minute; the page updates by itself.</p>
          </section>
        )}

        {result?.status === "error" && (
          <section className="roast-wait">
            <h1>That one didn&apos;t work</h1>
            <p className="run-result is-error">{result.error ?? "Something went wrong."}</p>
            <a className="btn" href="/roast">
              Try another site
            </a>
          </section>
        )}

        {result?.status === "done" && result.teardown && (
          <article className="roast-report" aria-labelledby="roast-head">
            <p className="li-cell-sub">{result.domain}</p>
            <h1 id="roast-head">{result.teardown.headline}</h1>
            <p className="roast-lede">{result.teardown.summary}</p>
            <ol className="roast-findings">
              {result.teardown.findings.map((f, i) => (
                <li key={i}>
                  <h2>{f.title}</h2>
                  <p>{f.detail}</p>
                  <p className="roast-fix">
                    <strong>Fix:</strong> {f.fix}
                  </p>
                </li>
              ))}
            </ol>
            {result.teardown.quick_win && (
              <section className="roast-win" aria-labelledby="roast-win">
                <h2 id="roast-win">Do this week</h2>
                <p>{result.teardown.quick_win}</p>
              </section>
            )}
            <p className="li-cell-sub">We&apos;ll be in touch about it. Want another site checked?</p>
            <a className="btn" href="/roast">
              Roast another site
            </a>
          </article>
        )}
      </main>
    </div>
  );
}
