// Sprint 2 acceptance (§15): name → domain resolution correct on a 30-company spot check.
// Free (plain HTTP): for up to 30 companies with a website, fetch the homepage and check that it
// names the company (pageMatch, as resolve uses). Writes docs/sprint2-spotcheck.md for the
// operator to confirm; a "no" here is a candidate wrong website, not a verdict.
// Usage: npm run spot-check
import { writeFileSync } from "node:fs";
import { pageMatch } from "@bs/core";
import { createPool } from "@bs/db";
import { fetchPage, pageText } from "@bs/integrations";

const pool = createPool(1);
const rows = (
  await pool.query<{ company_name: string; domain: string; country: string; city: string | null; checked: boolean }>(
    `select c.company_name, c.domain, c.country, (select ch.structured_intelligence ->> 'city' from challenges ch where ch.company_id = c.id limit 1) city,
            c.company_check is not null checked
       from companies c where c.domain is not null and c.company_name is not null
      order by md5(c.id::text) limit 30`,
  )
).rows;
await pool.end();

const out: { name: string; domain: string; country: string; how: string; verdict: string }[] = [];
for (const r of rows) {
  const page = await fetchPage(`https://${r.domain}/`).catch(() => null);
  const m = page ? pageMatch(pageText(page.html), r.company_name, r.city) : null;
  out.push({
    name: r.company_name,
    domain: r.domain,
    country: r.country,
    how: r.checked ? "company-check agent" : "job board or cache",
    verdict: !page ? "site did not load" : m === "city" ? "yes, with the city" : m === "name" ? "yes" : "no",
  });
  process.stdout.write(".");
}
const named = out.filter((x) => x.verdict.startsWith("yes")).length;
const md = [
  "# Sprint 2 spot check: name → website (§15 acceptance)",
  "",
  `Run ${new Date().toISOString().slice(0, 10)} on ${out.length} companies picked at random. "Homepage names it" is the free check the`,
  "resolver uses; tick each row you confirm is the company's real website.",
  "",
  `Homepage names the company: **${named} of ${out.length}**.`,
  "",
  "| Confirmed | Company | Website | Market | Found by | Homepage names it |",
  "|---|---|---|---|---|---|",
  ...out.map((x) => `| [ ] | ${x.name.replace(/\|/g, "/")} | ${x.domain} | ${x.country} | ${x.how} | ${x.verdict} |`),
  "",
].join("\n");
writeFileSync("docs/sprint2-spotcheck.md", md);
console.log(`\n${named} of ${out.length} homepages name their company; written to docs/sprint2-spotcheck.md`);
