# Sprint 0 — search test (company → website, size, age)

Run 2026-11-03 on 60 usable companies from the board measurement (20 per market: IN = Indeed 10,
Naukri 5, WorkIndia 5; UAE = Indeed 12, Naukrigulf 8; US = Indeed 20). Provider: Apify
`apify/google-search-scraper` only — **no Brave key yet, so no Brave comparison**.

**Cost:** 120 searches × $0.0045 = $0.54 (Apify) + $0.02 (OpenRouter, Haiku picks the domain).

## Results

| Step | IN | UAE | US | All |
|---|---|---|---|---|
| Search 1 `"<company>" <city> <country>` → official website found | 9/20 | 10/20 | 10/20 | **29/60 (48 %)** |
| …same domain as the one the board gave (where given) | 1/2 | 4/6 | 6/10 | 11/18 |
| Search 2 `site:linkedin.com/company "<company>"` → page found | | | | 39/60 (65 %, not checked for correct company) |
| …employee range shown in the snippet | | | | **7/60 (12 %)** |
| RDAP registration date for the 29 found domains | | | | 21/29 (`.ae` not served by rdap.org; some `.org` return 403) |

By board: Naukrigulf 6/8 resolved, Indeed IN 6/10, Indeed US 10/20, Indeed UAE 4/12,
Naukri 2/5, WorkIndia 1/5 (→ WorkIndia stays dropped).

Wrong picks seen: 2 of 29 (`smartdocs.ai` instead of `smartdocsnow.com`; `mcicoils.com` for
"Microwave Components"). The rest of the disagreements were misses (null), not wrong picks.

## What this means

1. **About half of companies resolve.** Use the board's own website field first (Indeed US
   54 %, Naukrigulf 42 %), search only when it's missing.
2. **Size from LinkedIn snippets is rare (12 %).** Most companies will be "Size unknown" and
   judged by age.
3. **Domain age is a weak stand-in for company age**, and many real SMBs have old domains
   (e.g. 1997, 2002, 2008 in this sample). With the current rule (size unknown + > 8 years →
   drop) many of them would be dropped.
4. **Cost doesn't fit the Apify free cycle at full volume.** Two searches per new company ≈
   $0.009. At ~1,200–1,800 new companies a month that is ≈ $11–16/month, against ≈ $2 left
   in the $5 Apify cycle after job boards.
5. Apify search runs need a run cap of at least $0.50 (actor minimum); real cost is bounded
   by queries × pages.

## Q62 — OpenRouter web search (run 2026-11-04)

Same 60 companies. `anthropic/claude-haiku-5.5` with the `web` plugin (engine Parallel, mode
fast, 10 results), strict JSON output; a domain counts only if a returned result is on that
domain, it is not a directory, and the model is confident (`acceptResolved`, PRD §5.1 step 5c).
Script: `npm run search:test`; results in `data/sprint0/search-q62.json`.

| | OpenRouter web search | Sprint 0 Apify Google Search |
|---|---|---|
| Website found | **38/60 (63 %)** | 29/60 (48 %) |
| Same as the board's website (18 given) | 9 found; 2 wrong, 2 renamed/parent sites, 5 misses | 11 |
| Clearly wrong picks | 2 (`smartdocs.ai`, `mcicoils.com` — the same two Sprint 0 got wrong) | 2 |
| Cost per company | **$0.0018** (OpenRouter, outside the Apify cap) | $0.0045 (Apify) |
| Latency | ~4.6 s per company | batched Apify run |

The 16 sites only OpenRouter found were checked by homepage title or by the cited pages
(about / contact / careers on the same domain): all 16 belong to the named company. 6 that
Sprint 0 found were missed. OpenRouter's `usage.cost` includes the search fee: account usage
rose $0.106 over the run, matching the reported $0.108.

**Decision:** OpenRouter web search is the resolver. At `SEARCH_DAILY_CAP` = 15 that is
≈ $0.81/month on OpenRouter and $0 on Apify, so the whole Apify cycle stays for job boards.

### Homepage check (2026-11-04)

The 22 misses re-run ($0.041) with a free homepage check for unsure picks
(`pickHomepage`, PRD §5.1 step 5c). A second search alone found 3 more (Orion Groups, Blue
World, Rajasthan Decor — searches vary run to run); the homepage check rescued 2 (Audit Vista
Tax, Rose Hill Memorial Gardens) and rejected 5 wrong or ambiguous candidates (a different
"Sky Group", Athena Insurance for Athena Enterprises, "Dar Al Ain" for Dar Al Musharkah, two
Indo Electricals sites, Alpha Finance with no Mumbai link). Albustan Medical Center is lost:
two different Albustan medical sites match. Combined: **43/60 (72 %)**, no new wrong picks.
The ~11 left are micro-firms with no findable site; they become "No website" cards (§5.1 5d).
