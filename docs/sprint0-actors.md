# Sprint 0 — job-board actor shortlist

Pulled 2026-11-02 from the Apify API with the operator's token. Account: **Apify FREE plan,
$5.00 credit per cycle** (cycle 2026-10-16 → 2026-11-15, ~$0.04 used). Prices are the
pay-per-event prices for the FREE plan. Pay-per-event actors include their own compute.

| Board | Market | Actor | 30-day users | Price on FREE plan | Inputs that matter |
|---|---|---|---|---|---|
| Naukri | IN | `valig/naukri-jobs-scraper` | 2,640 | $0.0004 / job + $0.001 / run | `keywords`, `location`, `jobAge`, `limit` |
| Indeed | IN, UAE, US | `valig/indeed-jobs-scraper` | 5,071 | $0.0001 / job + $0.001 / run | `country` (`in`, `ae`, `us`, also `sg`, `my`, `ph`), `title`, `location`, `limit` |
| Apna | IN | `getascraper/apna-co-scraper` | 89 | $0.00099 / job | `keyword`, `location`, `maxItems`; declares output fields incl. company, industry, address |
| WorkIndia | IN | `shahidirfan/Workindia-Jobs-Scraper` | 19 | $0.001 / job + $0.0005 / run | `keyword`, `city`, `results_wanted` |
| Bayt | UAE | `blackfalcondata/bayt-scraper` | 259 | $0.00099 / job + $0.0005 / run | `query`, `country=AE`, `maxResults` |
| NaukriGulf | UAE | `blackfalcondata/naukrigulf-scraper` | 250 | $0.001 / job + $0.005 / run | `query`, `location`, `maxResults` |
| ZipRecruiter | US | `fatihtahta/ziprecruiter-scraper` | 41 | $0.001 / job | `queries`, `location`, `limit` |
| Craigslist jobs | US | `solidcode/craigslist-scraper` | 108 | $0.0018 / job | `region`, `category=jjj` (Jobs), `searchTerm`, `maxResults` |
| Wellfound | US | `blackfalcondata/wellfound-scraper` | 494 | $0.003 / job + $0.005 / run | `query`, `location`, `maxResults` |
| Dubizzle Jobs | UAE | — | — | — | No jobs actor (property/cars only) → dropped |

Fallback for Naukri: `muhammetakkurtt/naukri-job-scraper` ($0.0015 / job, $0.003 detailed).
Cheapest alternative for Indeed: `curious_coder/indeed-scraper` ($0.0001 / job).

## Measurement plan (run 2026-11-03 — results in [sprint0-boards.md](sprint0-boards.md))

- 11 board × market runs, **50 posts each**: two queries × 25 posts, the same two queries
  everywhere so boards are comparable — "data entry" and "accounts assistant".
- Location: country-wide where the actor allows; Craigslist `region=newyork`.
- **Estimated cost: ≈ $0.55** of the $4.96 remaining credit.
- Measured per board: share of posts from 2–999-employee companies, share of desk roles,
  share of recruiter posts, share of company names that resolve to a real domain, and
  whether the output includes company size / website / full description.

## Budget note

On the FREE plan, all Apify use (job boards, Reddit, maybe search) must fit in **$5 per
cycle**. At these prices a daily rotation of ~100 posts costs roughly $0.30–$1.50 per month
on Indeed/Naukri, so it should fit; the final $/month table comes after the measurement.
