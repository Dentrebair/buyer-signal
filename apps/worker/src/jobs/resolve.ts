// The daily website search for cards with no website (§5.1 step 5c, §5.1a).
import {
  MAX_SIGNAL_AGE_DAYS,
  ResolvePayload,
  homepageCandidates,
  pickHomepage,
  runCompanyCheck,
} from "@bs/core";
import {
  cacheDomain,
  cachedDomain,
  expireStaleResolves,
  finishResolve,
  markSearched,
  pendingResolves,
  searchesToday,
  saveCompanyCheck,
} from "@bs/db";
import {
  pageText,
} from "@bs/integrations";
import { persistCard } from "./cards.ts";
import { type Deps } from "./deps.ts";

// ── resolve-batch: daily website search, best provisional score first (§5.1 step 5c) ──
// Every queued post already has a "No website" card; this attaches the website when found.
export async function resolveBatch(d: Deps): Promise<{ stale: number; cached: number; searched: number; resolved: number; noWebsite: number }> {
  const now = d.now();
  const stats = { stale: 0, cached: 0, searched: 0, resolved: 0, noWebsite: 0 };
  // §4.3: a post still unsearched at 21 days old is no longer searched (its card stays).
  stats.stale = (await expireStaleResolves(d.pool, now, MAX_SIGNAL_AGE_DAYS)).length;

  let quota = d.settings.searchDailyCap - (await searchesToday(d.pool, now));
  // Read a few more than the quota: rows answered by the cache cost nothing.
  for (const row of await pendingResolves(d.pool, Math.max(quota, 0) + 50)) {
    const payload = ResolvePayload.parse(row.payload);
    let domain = await cachedDomain(d.pool, row.cache_key); // an earlier row may have resolved this company
    if (domain === undefined) {
      if (quota <= 0) continue;
      quota--;
      stats.searched++;
      // §5.1a: the company-check agent searches, opens pages and judges the company.
      const check = await runCompanyCheck(
        { company: row.company_name, city: row.city, country: row.country, vertical: payload.job.vertical },
        {
          llm: d.llm,
          fetchText: async (url) => {
            const page = await d.fetchPage(url);
            return page ? { url: page.url, text: pageText(page.html) } : null;
          },
        },
      );
      await markSearched(d.pool, row.natural_id, now);
      domain = check.domain ?? (await checkHomepages(d, homepageCandidates(check.lastPick, check.citations, row.company_name), row));
      await cacheDomain(d.pool, row.cache_key, domain); // before the card: a crash here never pays twice
      await persistCard(d, payload, domain);
      const { citations: _c, lastPick: _p, ...found } = check;
      await saveCompanyCheck(d.pool, { domain, nameKey: `${row.country}:${row.cache_key}` }, { ...found, domain, checkedAt: now.toISOString() });
    } else {
      stats.cached++;
      await persistCard(d, payload, domain);
    }

    if (await finishResolve(d.pool, row.natural_id, domain ? "resolved" : "unresolved", now)) {
      if (domain) stats.resolved++;
      else stats.noWebsite++;
    }
  }
  return stats;
}

// Free check for candidates the model was unsure of: the homepage must name the company.
async function checkHomepages(d: Deps, candidates: string[], row: { company_name: string; city: string | null }): Promise<string | null> {
  const pages: { domain: string; text: string }[] = [];
  for (const domain of candidates) {
    const page = await d.fetchPage(`https://${domain}/`);
    if (page) pages.push({ domain, text: pageText(page.html) });
  }
  return pickHomepage(pages, row.company_name, row.city);
}
