// Website sniff (PRD §5.4) on the Sprint 0 companies' websites: free, plain HTTP. Measures how
// often each 4-Gate finding and pain flag fires before any of them becomes a scored challenge.
// Usage: npm run sniff:test -- [--limit 60] [--domain example.com]
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Country, VerticalSlug } from "@bs/core";
import { createPool } from "@bs/db";
import { sniffWebsite } from "@bs/integrations";

const { values } = parseArgs({ options: { limit: { type: "string", default: "60" }, domain: { type: "string" } } });
const OUT = "data/sprint0/sniff-test.json";

interface Row { company: string; market: Country; domain?: string | null; board_domain?: string | null }
// Verticals come from the seeded Sprint 0 companies (npm run db:seed).
const pool = createPool(1);
const seeded = (await pool.query<{ company_name: string; vertical: VerticalSlug }>("select company_name, vertical from companies where vertical is not null")).rows;
await pool.end();
const verticalOf = new Map(seeded.map((c) => [c.company_name, c.vertical]));
const runs = ["data/sprint0/search-q62.json", "data/sprint0/search-q62-misses.json"].flatMap((f) => (JSON.parse(readFileSync(f, "utf8")) as { rows: Row[] }).rows);
const byDomain = new Map<string, Row>();
for (const r of runs) for (const d of [r.board_domain, r.domain]) if (d && !byDomain.has(d)) byDomain.set(d, r);
const targets = values.domain ? [[values.domain, { company: values.domain, market: "us" } as Row] as const] : [...byDomain.entries()].slice(0, Number(values.limit));

const rows: object[] = [];
for (const [domain, r] of targets) {
  const t = Date.now();
  const res = await sniffWebsite({ domain, company: r.company, vertical: verticalOf.get(r.company) ?? null, country: r.market, now: new Date() });
  const ms = Date.now() - t;
  rows.push({ domain, company: r.company, market: r.market, vertical: verticalOf.get(r.company) ?? null, ms, ...res });
  if (!res.reachable) {
    console.log(`${domain.padEnd(32)} UNREACHABLE  ${ms}ms`);
    continue;
  }
  const a = res.audit;
  const flags = [
    a.clientRendered && "SPA",
    a.pain.pdfForms.length && `pdf×${a.pain.pdfForms.length}`,
    a.pain.mailtoOnly && "mailto-only",
    a.pain.noScheduling && "no-booking",
    a.gate4 !== "automated_or_na" && a.gate4,
    a.gate3.longForm && "long-form",
  ].filter(Boolean);
  console.log(`${domain.padEnd(32)} ${String(res.pages.length)}p ${String(res.tech.length).padStart(2)} tech  ${ms}ms  ${flags.join(" ")}`);
}
writeFileSync(OUT, JSON.stringify(rows, null, 1));
console.log(`→ ${OUT}`);
