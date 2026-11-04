// Q62 (PRD §12 item 1c): OpenRouter web search as the website resolver, on the 60 Sprint 0
// companies. Compares against the board's own website field (ground truth where given) and the
// Sprint 0 Apify Google Search result. Spends money only with --yes.
// Usage: npm run search:test -- [--limit 60] [--misses] [--yes]
//   --misses: only the companies the last full run did not resolve (writes search-q62-misses.json)
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { acceptResolved, bareDomain, buildResolve, homepageCandidates, pickHomepage } from "@bs/core";
import { createPool, gatedLlm } from "@bs/db";
import { OpenRouterClient, fetchPage, pageText } from "@bs/integrations";

const { values } = parseArgs({
  options: { limit: { type: "string", default: "60" }, misses: { type: "boolean", default: false }, yes: { type: "boolean", default: false } },
});
const OUT = values.misses ? "data/sprint0/search-q62-misses.json" : "data/sprint0/search-q62.json";

interface Sprint0Company {
  board: string;
  market: "in" | "ae" | "us";
  company: string;
  city: string;
  board_domain: string | null;
  resolved_domain: string | null;
}

let companies = (JSON.parse(readFileSync("data/sprint0/companies_resolved.json", "utf8")) as Sprint0Company[]).slice(0, Number(values.limit));
if (values.misses) {
  const last = JSON.parse(readFileSync("data/sprint0/search-q62.json", "utf8")) as { rows: { company: string; domain?: string | null }[] };
  const missed = new Set(last.rows.filter((r) => !r.domain).map((r) => r.company));
  companies = companies.filter((c) => missed.has(c.company));
}
const inner = new OpenRouterClient();
const worst = await inner.worstCaseUsd("resolve", buildResolve({ company: "x", city: "x", country: "us" }));
console.log(`${companies.length} companies, model ${inner.model("resolve")}, worst case ≈ $${(worst * companies.length).toFixed(3)}`);
if (!values.yes) {
  console.log("dry run — add --yes to spend");
  process.exit(0);
}

const pool = createPool(2);
const llm = gatedLlm(pool, inner, { monthlyCapUsd: Number(process.env.MONTHLY_CAP_USD ?? 20) });
const rows: object[] = [];
let cost = 0;
const t0 = Date.now();

for (const c of companies) {
  const started = Date.now();
  try {
    const out = await llm.json("resolve", buildResolve({ company: c.company, city: c.city || null, country: c.market }));
    const city = c.city || null;
    let domain = acceptResolved(out.data, out.citations ?? []);
    let via = domain ? "search" : null;
    const candidates = domain ? [] : homepageCandidates(out.data, out.citations ?? [], c.company);
    if (candidates.length) {
      const pages: { domain: string; text: string }[] = [];
      for (const cand of candidates) {
        const page = await fetchPage(`https://${cand}/`);
        if (page) pages.push({ domain: cand, text: pageText(page.html) });
      }
      domain = pickHomepage(pages, c.company, city);
      if (domain) via = "homepage";
    }
    cost += out.costUsd;
    rows.push({ ...c, picked: out.data, citations: out.citations, candidates, domain, via, costUsd: out.costUsd, ms: Date.now() - started });
    console.log(`${c.market} ${c.company.padEnd(45).slice(0, 45)} → ${domain ?? "—"}${via === "homepage" ? " [homepage]" : ""}  [cands ${candidates.join(",") || "-"}]  (board ${c.board_domain ?? "—"}, sprint0 ${c.resolved_domain ?? "—"})`);
  } catch (e) {
    rows.push({ ...c, error: String(e) });
    console.log(`${c.market} ${c.company} → ERROR ${String(e).slice(0, 200)}`);
  }
}
await pool.end();

type Row = Sprint0Company & { domain?: string | null; error?: string };
const done = rows as Row[];
// (via: "search" = the model was sure and cited; "homepage" = rescued by the homepage check)
const board = done.filter((r) => r.board_domain);
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && bareDomain(a) === bareDomain(b);
const summary = {
  companies: done.length,
  errors: done.filter((r) => r.error).length,
  found: done.filter((r) => r.domain).length,
  sprint0Found: done.filter((r) => r.resolved_domain).length,
  boardGiven: board.length,
  matchesBoard: board.filter((r) => same(r.domain, r.board_domain)).length,
  wrongVsBoard: board.filter((r) => r.domain && !same(r.domain, r.board_domain)).length,
  sprint0MatchesBoard: board.filter((r) => same(r.resolved_domain, r.board_domain)).length,
  agreesWithSprint0: done.filter((r) => same(r.domain, r.resolved_domain)).length,
  costUsd: Number(cost.toFixed(5)),
  seconds: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
