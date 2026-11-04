# Sprint 0 — job-board measurement results

Run 2026-11-03. Searches "data entry" and "accounts assistant", 25 posts each per board,
no location filter (Craigslist: New York). 433 unique posts. Each post was labelled by
`anthropic/claude-haiku-5.5` via OpenRouter (10 label failures from output truncation,
excluded). Raw data and scripts are in the session scratchpad, not the repo.

**Cost:** Apify ≈ $0.39 · OpenRouter $0.12 · total ≈ $0.51.

## Results

"Usable" = desk role, named employer, not a recruiter, not 1,000+ employees, some
automatable work. "Full text" = description longer than 500 characters.

| Board | Market | Posts | Usable | Recruiter | Full text | Size given | Website given | Notes |
|---|---|---|---|---|---|---|---|---|
| **Indeed** | IN | 50 | **84 %** | 0 % | 84 % | 14 % | 16 % | Clean, cheapest ($0.0001/post) |
| Naukri | IN | 48 | 52 % | **27 %** | 22 % | 0 % | 2 % | Many staffing firms; descriptions short (median 271 chars) |
| WorkIndia | IN | 50 | 86 % | 10 % | 12 % | 0 % | 0 % | Very small firms, short Hinglish text (≤ 410 chars), likely no website; returns a staff contact name (must not be stored) |
| Apna | IN | 25 | 36 % | 4 % | **0 %** | 0 % | 0 % | No description returned; free plan allows 1 run / 30 min |
| **Indeed** | UAE | 47 | **87 %** | 2 % | 92 % | 10 % | 10 % | Clean, cheapest |
| Naukrigulf | UAE | 50 | 50 % | 22 % | 70 % | 0 % | **42 %** | 38 % "confidential" employers; returns contact emails (must not be stored) |
| Bayt | UAE | 43 | 56 % | 9 % | 93 % | 0 % | 0 % | Returns off-search results (engineering roles); 28 % large firms |
| **Indeed** | US | 50 | **82 %** | 2 % | 94 % | **44 %** | **54 %** | Best metadata of any board |
| Craigslist | US | 38 | 13 % | 13 % | 92 % | 0 % | 0 % | Employer named in only 42 % |
| Wellfound | US | 22 | 68 % | 0 % | 100 % | 100 % | 0 % | Tech startups; 0 % high-automation work; "accounts assistant" found 1 post |
| ZipRecruiter | US | — | — | — | — | — | — | Not measured: actor requires a run cap of at least $1.00 |

## Recommendation

| Market | Primary | Secondary | Dropped |
|---|---|---|---|
| India | Indeed India | Naukri (recruiter filter + blocklist essential) | Apna (no text), WorkIndia (pending domain test) |
| UAE | Indeed UAE | Naukrigulf (website field helps resolution) | Bayt (off-search noise) |
| US | Indeed US | — | Craigslist, Wellfound; ZipRecruiter optional |

## Estimated job-board spend

200 posts/day ≈ 6,000/month, split as above: posts ≈ $1.80 + run starts ≈ $0.50–1.20
→ **≈ $2.50–3.00/month** of the $5 Apify cycle. Reddit and (if chosen) the Apify search
actor share the remaining ≈ $2.

## Still to measure

- **Size in range (2–999):** boards rarely give size (only Indeed US often does), so the
  size check depends on the LinkedIn company snippet and RDAP lookups. Measured in the
  search comparison (§12 item 1b).
- **Company → domain resolution rate:** same step. Decides whether WorkIndia stays dropped.
- **Naukri full text:** the cheap actor's descriptions are short. Test the fallback actor's
  detailed mode ($0.003/post) on 25 posts if Naukri recall falls short in Sprint 2.

## Ingestion rules learned from the data

- Drop board fields that hold personal data: WorkIndia `branch_contact_person_name`,
  Naukrigulf `contactEmail`, Bayt/Wellfound `extractedPhones` / `extractedEmails`.
- Treat "Confidential Company" and "Client of …" employers as unattributable → drop.
- Naukri `company.hiringFor` set → strong recruiter signal (of 15 such posts, 12 were
  staffing firms and 1 was posted under a person's name). Not decisive alone: some employers fill it with their own name,
  so compare it with `company.name` and still run the RECRUITER trie + blocklist.
- Label output needs `max_tokens` ≥ 1,000 to avoid truncated JSON.

## Freshness (added 2026-11-03, PRD §4.3)

This measurement ran **without** a date filter. Share of posts older than 21 days:
Indeed IN 62 %, Indeed UAE 66 %, Indeed US 24 %, Naukrigulf 38 %, Naukri 2 % (ran with
`jobAge: 15`). Production runs use each actor's date filter (Indeed 14 days, Naukri and
Naukrigulf 15 days), so fresh volume per search must be re-checked before locking the
rotation size — one capped Indeed run per market with `datePosted: "14"`.
