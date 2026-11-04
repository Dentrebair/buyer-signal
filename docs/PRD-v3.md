# B2B Pain-Point Intelligence Engine — PRD v3.0 (MVP)

Status: agreed design, pre-build · Supersedes: PRD v2.1 Master, Developer Sprint Roadmap v2.1 · Date: 2026-11-02

This document folds every decision from the v2.1 design review into one source of truth.
Where v2.1 and this document disagree, this document wins. The decision log (§14) maps each
review question to its answer so later summaries cannot drift.

---

## 1. What we are building

A single-operator tool for one agency. It finds SMB/MSME companies that are **paying humans to
do work an AI workflow could do**, proves it with evidence, scores the company, and hands the
operator three ready-to-copy cold emails.

**Core pitch (primary):** AI automation of back-office work —
- **Labor arbitrage:** job posts hiring manual clerks (data entry, dispatch, reconciliation).
- **Integration debt / Shadow IT:** disjointed tool stacks detected on the company website.
- **Static document friction:** PDF intake forms, lease apps, tariffs, questionnaires.
- **Information silos & training friction:** missing SOPs, scattered files, staff relying on
  the owner for answers → pitch an AI knowledge base (RAG) as a 24/7 internal training and
  retrieval agent (§6.6).

**Target companies:** SMBs/MSMEs, startups and mid-size companies (2–999 employees). Enterprises
(≥ 1,000), recruiters, staffing agencies and BPOs are filtered out (§6.7).

**Secondary wedges:** website redesign, AEO/GEO fixes, WhatsApp lead capture — surfaced by the
4-Gate audit and used as foot-in-the-door angles, never as the main pitch.

**Out of scope for the system:** sending email or WhatsApp. The operator copies drafts and sends
them from their own tools.

## 2. Summary of decisions

| Area | Decision |
|---|---|
| Operator | One agency, one operator, no multi-tenancy. Supabase email/password; public sign-ups disabled. |
| Stack | TypeScript + Zod. Next.js (current stable) web service + Node worker service on **Railway**. Supabase Postgres (pgvector, pgcrypto) also holds dedup keys, caches, spend counters and rate limits — **no Redis in v1** (Q63; Redis is a scale-up option, §18). |
| Queue & schedule | **pg-boss** in Supabase Postgres. Cron via `boss.schedule()`. No QStash, no Vercel Cron, no edge runtime. |
| Budget | **$20/month for variable API spend only** (Apify, Brave, OpenRouter, Gemini embeddings). Infra (Railway, Supabase) is separate. Spend counter pauses paid queues at the cap. **Apify has its own hard cap of $4.50 per Apify billing cycle** (free plan, $5 credit) covering job boards, search and Reddit together (§5.3, Q58). |
| Markets | India, UAE, US. **Indeed only** in all three markets (Sprint 0 measurement + Q58); Naukri and Naukrigulf kept as tested fallbacks, off in v1 (§4.1). |
| Verticals | **16 verticals** (§4.1b), each run only in the markets where it fits (45 vertical × market slots). Marketing agencies excluded (they sell AI themselves). |
| Company size | Known: 2–999 employees (SMB 2–249, Mid-size 250–999). Unknown: domain age tags Startup (< 4 y) / Growth (4–6 y), otherwise "Size unknown" and kept (§6.7, Q57). Tags don't affect score. Recruiters and staffing firms dropped. |
| v1 sources | Job posts (spine) → resolved domain → website sniff (DOM + tech-stack + 4-Gate). Company posts (founder, employee or company page): LinkedIn (search-result snippets) and attributable Reddit posts (§4.1a). Plus `/roast` inbound. |
| Freshness | **Only signals posted in the last 21 days** (job posts, LinkedIn and Reddit posts). Filtered at the source where the actor allows it and re-checked by the worker (§4.3). |
| Out of v1 | Web Unlocker, directory/Google Maps/CSV seeding, reviews (customer + employee), Gate 2 vision, reverse stack-sniff, keyboard shortcuts, sending. |
| Card unit | **Company.** Signals are evidence rows on the company. |
| Score | Best single signal + triangulation bonus M. `B = 0` for structural signals. Inbound = 100. |
| Board | Triage (71–100), Nurture (50–70), Actioned. `< 50` and rejected are hidden. |
| Drafts | **On demand only** — Generate button in the drawer; never automatic. One call returns 3 emails (direct / peer-benchmark / educational), one marked recommended, each with a Copy button. |
| Models | All LLM text tasks go through **OpenRouter**, with one model setting per task (`MODEL_EXTRACTION`, `MODEL_DRAFTS`, `MODEL_ROAST`) so models can be swapped without code changes. Starting picks: a fast, cheap model for extraction; a strong writing model (e.g. Gemini Pro-tier) for drafts. Embeddings: `gemini-embedding-001` @ 768 dims via Google directly. Exact model slugs pinned and verified in Sprint 0. |

## 3. Architecture

```
                 ┌────────────── Railway ───────────────┐
 Apify actors ──►│ web: Next.js                         │
 (Indeed,        │   POST /api/webhooks/apify ──┐       │
  Naukri)        │   /dashboard, /radar, /roast │       │
                 │                              ▼       │
                 │ worker: Node + pg-boss  ◄── jobs ───►│── Supabase Postgres
                 │   queues (§5.2)                      │     (data + pg-boss tables)
                 └──────────────┬───────────────────────┘
                                │
                Postgres also holds: seen_items (dedup), domain_cache, spend_counters, rate_hits (Q63)
                External APIs: Apify (boards, search, Reddit), Brave Search (later), OpenRouter, Gemini (embeddings), Cloudflare Turnstile
```

- **web** serves the UI and thin API routes. It never does heavy parsing or LLM calls inline;
  it enqueues jobs.
- **worker** runs every pipeline step. No request timeouts apply.
- pg-boss connects with Supabase's **session** connection string (port 5432), not the
  transaction pooler. (Verify from Railway in Sprint 1.)
- The worker's polling keeps the Supabase free-tier project from pausing for inactivity.

## 4. Sources & signal taxonomy (v1)

| `source_type` | Source family (for M) | Origin | E | I | B |
|---|---|---|---|---|---|
| `job_post` | `job_post` | Job boards chosen in Sprint 0 (§4.1) | 90 | 75 | from LLM `BlastRadiusHypothesis` (0–30) |
| `linkedin_post` | `linkedin_post` | Search-result snippets, `site:linkedin.com/posts` | by author (below) | by author (below) | from LLM (0–30) |
| `social_post` | `social_post` | Reddit, attributable posts only | 75 | by author (below) | from LLM (0–30) |
| `dom_sniff` | `website` | Fetch of resolved domain | 95 | 30 | **0 (hardcoded)** |
| `tech_stack` | `website` | Same fetch, fingerprint match | 80 | 35 | **0 (hardcoded)** |
| `inbound` | `inbound` | `/roast` form | 100 | 100 | n/a (score override) |

**Company posts by author relation (Q59, Q60):**

| `author_relation` | LinkedIn E / I | Reddit E / I | Base score (B = 0) |
|---|---|---|---|
| `founder_owner` | 85 / 90 | 75 / 85 | 61 / 56 |
| `company_page` | 80 / 80 | — | 56 |
| `employee` (current) | 80 / 65 | 75 / 60 | 51 / 47 |

Dropped before scoring (`dropped_stance`): `vendor` (selling a fix), `commentator` (not
about their own company), `former_employee`, `recruiter`, and any author whose stance is not
`suffering`.

Founder-dependency override: if any `INFORMATION_SILO` or `OWNER_DEPENDENCY` atom matched,
middleware sets `founder_dependency_flag = true` (+10, once) before scoring, whatever the LLM
returned (§6.6).

Later phases add: `serp_review`, `customer_review`, `reverse_stack_sniff` (E/I values as in
v2.1 §4).

### 4.1 Job boards and ingestion rotation

**Board selection (Sprint 0, done 2026-11-03 — [sprint0-boards.md](sprint0-boards.md)).**
Measured 50 posts per candidate board per market. **Indeed won in all three markets**
(82–87 % usable posts, ≤ 2 % recruiters, cheapest at $0.0001/post) and is the only board in v1
(Q58). Naukri (IN) and Naukrigulf (UAE) are tested fallbacks, switched off to stay inside the
Apify cap. If the Indeed actor breaks, fall back to `curious_coder/indeed-scraper`.

| Market | Candidates |
|---|---|
| India | Naukri, Indeed India, Apna, WorkIndia |
| UAE | Indeed UAE, Bayt, Naukrigulf, Dubizzle Jobs |
| US | Indeed, ZipRecruiter, Craigslist jobs, Wellfound |

A candidate is only measured if a usable Apify actor (or official API) exists for it.

**Rotation.** Daily pg-boss cron `ingest-rotation` runs **3 slots per day × 35 posts**
(`BOARD_SLOTS_PER_DAY`, `BOARD_POSTS_PER_SLOT`) on Indeed with `datePosted: "14"`. The 45
slots in §4.1b cycle in 15 days. Volume is sized to what the daily search quota (§5.1 step 5)
can resolve — pulling more posts than can be looked up only wastes Apify credit. Each vertical has 2–4 manual-role search titles (from
§6.3 phrase mining). After a full cycle, slots with a low pass rate (few posts surviving the
Bouncer) drop to every second cycle, so volume shifts to the verticals that produce cards.

### 4.1b Verticals and markets

| # | Vertical | Typical desk work to automate | IN | UAE | US |
|---|---|---|---|---|---|
| 1 | Real estate & property management | Listings entry, lease paperwork, tenant queries | ✓ | ✓ | ✓ |
| 2 | Logistics, freight & customs brokerage | Shipment docs, tracking updates, customs filings | ✓ | ✓ | ✓ |
| 3 | Accounting, bookkeeping & tax | Invoice entry, reconciliation, client document chasing | ✓ | ✓ | ✓ |
| 4 | Healthcare clinics & dental | Appointments, patient intake forms, insurance claims | ✓ | ✓ | ✓ |
| 5 | Legal (law firms) | Intake, document drafting, case file admin | ✓ | ✓ | ✓ |
| 6 | Professional services (consulting, architecture, engineering) | Proposals, timesheets, project admin | ✓ | ✓ | ✓ |
| 7 | Retail & e-commerce | Catalogue upload, order processing, customer support | ✓ | ✓ | ✓ |
| 8 | Insurance agencies & brokers | Quotes, policy entry, renewals, claims paperwork | ✓ | ✓ | ✓ |
| 9 | Lending & financial advisory (mortgage brokers, NBFC/DSA, wealth) | Loan file collection, KYC documents, CRM entry | ✓ | ✓ | ✓ |
| 10 | Travel & tour operators | Bookings, itineraries, visa paperwork | ✓ | ✓ | ✓ |
| 11 | Education & training (coaching institutes, training providers) | Admissions, fee follow-ups, student queries | ✓ | ✓ | — |
| 12 | Manufacturing | Purchase orders, inventory entry, dispatch paperwork | ✓ | — | ✓ |
| 13 | Wholesale, distribution & trading | Order entry, invoicing, stock updates | ✓ | ✓ | ✓ |
| 14 | Construction, contracting & fit-out | Quotes, site reports, subcontractor billing | ✓ | ✓ | ✓ |
| 15 | Home, field & facility services (HVAC, plumbing, pest control, FM) | Dispatch, scheduling, job sheets, invoicing | — | ✓ | ✓ |
| 16 | Automotive dealers & service centres | Lead entry, service bookings, DMS data entry | ✓ | ✓ | ✓ |

Slots: India 15, UAE 15, US 15 = 45. The market marks are a starting point; a slot with a
near-zero pass rate after two cycles is switched off and shown on `/radar`.
`companies.vertical` and `ingestion_runs.vertical` store the vertical's slug.

### 4.1a Company posts (LinkedIn, Reddit)

- **LinkedIn:** Apify Google Search queries `site:linkedin.com/posts` combined with
  first-person pain phrases per vertical ("we still", "our team spends", "I spend half my
  day"; §6.6 list and mined phrases) — any author: founder, employee or company page — with
  `quickDateRange: "d21"` (§4.3), up to `LINKEDIN_SEARCH_DAILY_CAP` per day, rotated
  alongside job posts. Use the result snippet only (Brave's extra snippets become available
  if Brave is adopted later); never fetch LinkedIn pages. **Company name, most reliable
  first:** (1) company-page posts carry the company in the URL
  (`linkedin.com/posts/<company-slug>_…`); (2) the author headline in the snippet ("… at Acme
  Trading LLC"); (3) the post text ("our team at Acme"), extracted by the LLM. The LLM never
  supplies a website from memory — in Sprint 0 it named 8 of 60 sites, 4 of them wrong — so
  the name always goes through entity resolution (§5.1 step 5). Unattributable → drop.
  Cards from LinkedIn carry a **"Snippet only — read the post"** badge; the operator opens
  the post to judge it before generating a draft.
- **Reddit:** via an **Apify Reddit actor** (Q53) — no Reddit API account. Subreddits per vertical (e.g. small-business, freight,
  bookkeeping, dental, real-estate communities). Becomes a company card **only** if the
  post names the company or links its website; anonymous posts go to the trends track
  (Sprint 4).
- **Author check (LinkedIn and Reddit, Q59):** the extraction LLM returns
  `author_relation` (`founder_owner`, `employee`, `company_page`, `former_employee`,
  `vendor`, `commentator`, `recruiter`) and `stance` (`suffering`, `selling`,
  `commenting`). Only `founder_owner`, `employee` and `company_page` with stance `suffering`
  become a challenge, scored per the table in §4; the rest are dropped and counted as
  `dropped_stance`. "Former", "ex-" or a past-tense role in the headline → `former_employee`.
- **Employee posts protect the employee (Q61):** no author name, role or email is stored;
  only the post URL and the evidence sentences. Drafts never mention the employee, their
  post or "someone on your team" — they pitch the general problem. The card shows
  **"Employee post — don't quote"**.

### 4.3 Freshness rule (21 days)

Only signals published in the **last 21 days** are collected. Two layers:

1. **At the source** (saves money): each actor gets its tightest date filter that covers
   21 days — Indeed `datePosted: "14"`, Naukri `jobAge: "15"`, Naukrigulf `datePosted: 15` (its options are 1/3/7/15),
   Apify Google Search (LinkedIn posts) `quickDateRange: "d21"`, the Reddit actor's
   time filter (verified when the actor is chosen, §12).
2. **In the worker** (`fetch-dataset`, before dedup): the item's own posting date is
   checked; older than 21 days → drop, count `dropped_stale`. An item with **no date** is
   dropped too, unless the source filter was applied in that run. LinkedIn snippets with no
   date shown are kept only when the search used the date filter.

The rule covers *signals*. Facts looked up about a company (its website as it is today,
LinkedIn company size, domain registration date) describe the company's current state and
are not age-filtered. Every challenge stores its `posted_at`; the card shows it.

Measured on 2026-11-03 without a date filter, 62–66 % of Indeed India/UAE posts and 24 % of
Indeed US posts were older than 21 days — so the source filter matters for volume.
- Stored per post: URL, snippet, company, author's **name and public role**
  (§6.5). Dedup key: `dedup:post:{post_url}`.

### 4.2 Seed pipeline

`seed_urls` is filled **only** by signals: a job post resolving to a canonical domain, or a
`/roast` submission. Seed sniffs are $0 (plain HTTP, deterministic analysis), so the worker
processes pending seeds automatically. The **[Run Now]** button on `/radar` immediately enqueues
the next 100 pending seeds — used for testing and catching up.

## 5. Pipeline

### 5.1 Flow A — job posts

1. **Webhook** `POST /api/webhooks/apify`: verify the `X-Apify-Webhook-Secret` header (constant-time) →
   enqueue `apify-run-event { apifyRunId }` → respond `202` (measured 0.17 s warm). Apify webhooks
   carry run metadata, not items; the worker reads the run, settles its exact cost from
   `chargedEventCounts`, then enqueues `fetch-dataset`. *Verified 2026-11-03:* one **persistent**
   webhook per actor (`POST /v2/webhooks`, secret in the JSON body, `idempotencyKey`), registered by
   `npm run apify:webhook` at deploy — not per-run ad-hoc webhooks, which travel base64-encoded in the
   start-run URL and would put the secret in logs. A `poll-runs` job (every 5 min) sends the same event
   for runs still marked running: a safety net for lost webhooks, and the only path locally, where
   Apify cannot reach `localhost`.
2. **fetch-dataset:** page through dataset items 25 at a time. For each item:
   `INSERT INTO seen_items (natural_id, expires_at) VALUES ($1, now() + interval '30 days')
   ON CONFLICT DO NOTHING` (natural ID = `job:` + posting ID, else canonical posting URL;
   0 rows inserted = already seen). Before that, the freshness check (§4.3): older than 21 days or undated →
   drop, count `dropped_stale`. Already-seen → drop, count `dropped_dedup`.
3. **gate-job-post (no cost):** Cheerio-minify the description; run the Aho-Corasick trie.
   Drop if a `RECRUITER` atom matches or the poster is on the staffing-firm blocklist
   (`dropped_recruiter`). Require **≥ 2 atoms across `AUTOMATABLE_TASK`,
   `INFORMATION_SILO` and `DOCUMENT_FRICTION`** and a desk role (not physical/clinical).
   Fail → drop, count `dropped_trie`. Pass → Semantic Node Extraction (§6.2).
4. **extract-llm (cheap, before any search — Q56):** `MODEL_EXTRACTION` via OpenRouter,
   XML-delimited envelope → `StructuredIntelligence` (Zod-validated, no `outreach_draft`).
   Invalid output → one retry, then fail job. The envelope holds: the **full text** of the
   post when it is under ~1,500 words (otherwise the minified text, truncated around the
   matches), the semantic nodes marked as the evidence to focus on, and — if the company is
   already known — its `structural_flags`, `tech_stack` and `company_dossier_summary`. The
   output also includes `automation_fit` (none / some / high), `known_large_brand` (true when
   the employer is a widely known 1,000+ company) and, for LinkedIn/Reddit posts, `author_relation` + `stance` (§4.1a).
   `automation_fit = none` or `known_large_brand` → drop (`dropped_no_fit`, `dropped_size`)
   **without spending a search**.
5. **resolve-entity (daily search quota):**
   a. Board website field first (Indeed `employer.corporateWebsite`, free) → done.
   b. `domain_cache` row for `{normalized_name}:{city|vertical}`, not expired → done.
   c. Otherwise the post joins the **search queue, ordered by provisional signal score**
      (§7). Up to `SEARCH_DAILY_CAP` (default 15) searches run per day (`resolve-batch`,
      04:00 UTC) through OpenRouter web search (Q62): `"<company_name>" <city> <country>`,
      top 10 results → LLM picks the official domain or null; a domain no result is on is a
      miss. An unsure pick (low confidence, or a cited domain spelling the company name) gets
      a free homepage check: exactly one candidate page must name the company and its city,
      or name a 2+-word company whose domain spells it; ambiguous → miss. Cache 30 days
      (misses 7 days). A post still unsearched when it turns 21 days old leaves the queue.
   d. **No website is still a lead** (decided 2026-11-04). The card is created at extraction,
      before any search, marked **"No website"** and keyed on
      `name_key = <country>:<normalized name>:<city>`; a website found later (search, or a
      later post's board field) is attached to the same card, or the card is folded into the
      company that already owns that domain. No-website cards get no website sniff, and the
      pitch is the hiring need in the post, never website work (§9). Only posts with no
      company name at all are dropped (`dropped_unresolved`).
6. **Size check (§6.7)**, before the company is created: board size field, then domain age.
   Out of range → drop (`dropped_size`); the site is never scraped.
7. **Upsert company** on `domain`; insert `seed_urls` row if new (→ website sniff, §5.4).
8. **Insert challenge** + **recompute company score** in one transaction (§7). No draft is
   generated here; drafts are on demand only (§9).

Company posts (§4.1a) follow the same steps 2–8 with `gate-post` in place of
`gate-job-post`: **≥ 1 pain atom** (snippets are ~150 characters), no desk-role check.

### 5.2 pg-boss queues

| Queue | Concurrency | Paid? | Notes |
|---|---|---|---|
| `ingest-rotation` | 1 | Apify | Cron, daily |
| `fetch-dataset` | 1 | — | Pages Apify dataset |
| `gate-job-post`, `gate-post` | 4 | — | Trie + node extraction |
| `search-founder-posts` | 1 | Apify | LinkedIn post search (`LINKEDIN_SEARCH_DAILY_CAP`), Reddit (`REDDIT_DAILY_POSTS`) |
| `resolve-entity` | 1 | Apify | Board website → cache → daily batched search, highest score first (`SEARCH_DAILY_CAP`) |
| `sniff-domain` | 4 | — | Fetch + DOM + tech + 4-Gate |
| `extract-llm` | 2 | OpenRouter | `MODEL_EXTRACTION` |
| `draft-llm` | 1 | OpenRouter | `MODEL_DRAFTS`; only enqueued by the Generate button |
| `roast` | 2 | OpenRouter | `MODEL_ROAST`; inbound audits |
| `embed-trends`, `cluster-trends` | 1 | Gemini | Sprint 4 |
| `mine-keywords` | 1 | Apify / OpenRouter | Low priority; one vertical × 20 posts per job (§6.3) |
| `audit-dropped` | 1 | OpenRouter | Daily, low priority; LLM re-reads a 2 % sample of trie drops (§6.3) |

Concurrency numbers are initial; tune after verifying provider rate limits.

### 5.3 Budget enforcement

- Every paid call writes a `spend_events` row and updates its `spend_counters` row in the
  same transaction.
  Cost source: provider-reported usage where available (Apify run usage, OpenRouter's
  per-request cost, Gemini embedding token counts × list price); otherwise a configured
  unit price.
- All LLM calls go through one small client wrapper that takes a task name, looks up its
  model setting, requests structured JSON output, validates with Zod, and records cost.
  Changing a model is an env-var change; the model actually used is stored with each
  challenge and draft so quality can be compared across models.
- Before any paid job runs, the worker reserves its worst-case cost atomically:
  `UPDATE spend_counters SET total = total + $cost WHERE key = $k AND total + $cost <= cap
  RETURNING total` — no row returned = over cap. Keys: `month:{YYYY-MM}` against
  `MONTHLY_CAP_USD` (default 20) and `apify:{cycle_start}` (below). At or over cap → the job is re-queued with `startAfter` = next check
  (1 hour); paid queues effectively pause; free queues keep running.
- **Apify cycle cap (Q58).** Apify's free plan gives $5 per billing cycle (cycle dates from
  the Apify API, currently the 16th → 15th). Counter `apify:{cycle_start}`; cap
  `APIFY_CYCLE_CAP_USD` (default 4.50, leaving $0.50 headroom). Before each Apify run the
  worker adds the run's worst case (`maxItems × price + start`) to the counter and refuses
  the run if that would cross the cap. Every run also sets Apify's own `maxItems` and
  `maxTotalChargeUsd` (search actor minimum $0.50; real cost stays bounded by queries ×
  pages). A daily job reads Apify's real cycle usage (`/users/me/usage/monthly`) and
  overwrites the counter with it, so the gate always uses Apify's own number.
- **Apify budget split** (per 30-day cycle, at default settings):

  | Use | Setting | Volume | ≈ Cost |
  |---|---|---|---|
  | Indeed job posts | 3 slots/day × 35 posts | ~3,150 posts | $0.50 |
  | Company website search | `SEARCH_DAILY_CAP=15` | ~450 searches | $2.03 |
  | LinkedIn company-post search | `LINKEDIN_SEARCH_DAILY_CAP=3` | ~90 searches | $0.41 |
  | Reddit company posts | `REDDIT_DAILY_POSTS=10` | ~300 posts | $0.50 |
  | **Total** | | | **≈ $3.45** of the $4.50 cap |

  Raising any setting is an env change; `/radar` shows projected cycle spend before it is
  reached. Adding Brave later moves search off Apify and frees ~$2.40.
- `/radar` shows spend per provider vs cap. `spend_counters` is the gate; `spend_events` is
  the auditable record (reconcile monthly).

### 5.3a Reliability rules (every queue)

The system is built to slow down, not fall over. Each rule applies to every job:

- **Small units of work.** A job handles one item or one small batch (≤ 25 dataset items,
  20 posts for mining, one domain for a sniff). A big task is many small jobs, so a crash
  loses at most one batch and the queue resumes where it stopped.
- **Safe to run twice.** Every job can be retried without creating duplicates: `seen_items`
  dedup keys, `natural_id` / `domain` unique constraints, and upserts instead of inserts.
- **Bounded retries.** Network/provider errors retry up to 3 times with exponential backoff
  (30 s → 2 min → 8 min). Bad input (Zod failure after one retry, 4xx) fails immediately.
  Failed jobs stay in pg-boss's failed state and are counted on `/radar`; nothing is
  silently dropped.
- **Timeouts everywhere.** Every outbound call has a timeout (HTTP 8–30 s by provider; LLM
  60 s); every job has a pg-boss `expireIn` so a hung job is reclaimed.
- **Per-provider limits.** Queue concurrency (§5.2) caps parallel calls to each provider. If
  one provider fails 5 times in a row, its queues pause for 10 minutes (circuit breaker) while
  every other queue keeps running.
- **Live work first.** Pipeline queues run at normal priority; background jobs
  (`mine-keywords`, `audit-dropped`, `cluster-trends`) run at low priority, so they never
  delay live ingestion.
- **One cron at a time.** Scheduled jobs use pg-boss singleton keys, so a slow run is never
  overlapped by the next one.
- **Clean restarts.** On a Railway deploy or restart the worker stops taking new jobs,
  finishes or releases running ones (`boss.stop({ graceful: true })`), then exits.
  Unfinished jobs are picked up by the new worker.
- **Budget cap** (§5.3) pauses paid queues; free queues keep running.
- **Visible health.** `/radar` shows queue depth, failed jobs, paused queues and spend.

### 5.4 Flow B — website sniff (`sniff-domain`)

1. SSRF-safe fetch of the homepage (+ up to 3 linked pages: contact, services, careers)
   — §8.2 guards apply here too. `403`/bot wall/timeout → `seed_urls.status = 'unreachable'`,
   `companies.reachable = false`. No unblocking, no retries beyond one.
2. **SPA guard:** visible text < 100 chars and `<div id="root">`/`<div id="__next">`/`<app-root>`
   → `is_client_rendered = true`; skip all "absence of X" assertions (no false negatives).
3. **Tech-stack matcher:** run `enthec/webappanalyzer` fingerprints (headers, script `src`,
   meta, cookies, HTML patterns) against the fetched response. Store in `companies.tech_stack`.
   Emit a `tech_stack` challenge only when a friction pattern matches (e.g. ≥ 3 unconnected
   SaaS form/CRM/booking tools; legacy portal software).
4. **DOM sniff + 4-Gate audit** (§6.4). Emit a `dom_sniff` challenge only when a pain flag is
   found (static PDF intake, raw `mailto:` instead of form, no scheduling, etc.).
5. Recompute company score.

*Built 2026-11-04 ([sprint2-sniff.md](sprint2-sniff.md)).* `sniff-seeds` cron every 10 min
claims ≤ 20 pending seeds and sends one `sniff-domain` job each (concurrency 4); a seed stuck
> 1 h is reclaimed, failed after 3 attempts. A homepage that redirects to another domain is
treated as not the company's site. Fingerprints: `enthec/webappanalyzer` pinned to one commit
(`npm run fingerprints:update`), static fields only (headers, cookies, meta, HTML, script src,
inline scripts, DOM, text). Gate 4 is IN/UAE only (US → `automated_or_na`). "No scheduling" only
in booking verticals (healthcare, legal, field services, automotive, education, real estate).
`dom_sniff` = PDF intake form, email-link-only enquiries, or no booking; `tech_stack` = ≥ 3
separate SaaS form/CRM/booking/chat/marketing tools. Gates 2–3 are audit-only. Measured on 47
real sites: `dom_sniff` 6 %, `tech_stack` 0 %.

### 5.5 Flow C — `/roast` inbound (§8)

### 5.6 Flow D — anonymous trends (Sprint 4, stretch)

Reddit/community posts → trie → `AnonymousTrendExtraction` → `gemini-embedding-001`
(768 dims) → `macro_trends` → weekly `match_macro_trends` RPC (cosine ≥ 0.82) →
`trend_clusters`. Read-only "Macro Trends" view. No reverse stack-sniff in v1.

## 6. The Bouncer (deterministic, $0)

### 6.1 HTML minification
Cheerio: strip `<script>` (after fingerprinting), `<style>`, `<svg>`, `<nav>`, `<footer>`
(after copyright-year and contact extraction), `<noscript>`, comments. Target < 10 KB text.

### 6.2 Semantic Node Extraction
If a trie match falls inside a `<p>` or `<li>`, extract the whole node. Use compromise.js to
capture the full clause (subject + verb + object) around the match. Store node HTML, clause,
and match offsets in `challenges.semantic_nodes` for the Proof Viewer.

### 6.3 Keyword tries — built from real data
1. **Mine in small batches** (`mine-keywords` queue, low priority, §5.3a). Each job pulls
   **20 posts for one vertical**, spread across the markets it runs in. One shared core
   list is mined from all verticals' posts pooled (plus the ~550 Sprint 0 measurement
   posts); each vertical's own posts add only its vertical-specific terms. These are
   separate from the 20 held-out evaluation posts per vertical (step 3), which are never
   used for mining.
2. Mine candidate phrases with LLM help (one-off cost, < $1). Label each phrase with a
   semantic category: `AUTOMATABLE_TASK`, `MANUAL_ROLE`, `INTEGRATION_DEBT`,
   `DOCUMENT_FRICTION`, `INFORMATION_SILO`, `OWNER_DEPENDENCY`, `PHYSICAL_ROLE` (exclusion),
   `RECRUITER` (exclusion). The §6.6 phrases are seeds, validated like any other phrase.
   The LLM also suggests variants of each phrase (synonyms, local terms, abbreviations); a
   variant is kept only if it appears in at least one real post.
3. Labelled evaluation set: **320 posts (20 per vertical)**, LLM pre-labelled, operator
   reviews and corrects (about 2–3 hours of review). Include information-silo posts in the set.
4. **Gate:** recall ≥ 85 % pooled and ≥ 70 % in every vertical. Precision reported, not gated.
5. **Check, then fetch more only if needed.** After each batch the vertical is tested. Below
   70 % recall → enqueue another 20-post batch for that vertical only. Stop at 5 batches
   (100 posts); a vertical that still fails is switched off in the rotation and flagged to
   the operator. Expected total ≈ 320–700 posts, < $0.50 of Apify credit.
6. **Ongoing leak check** (`audit-dropped`, daily, ≈ $0.10/month): the LLM reads a random
   2 % of posts the trie dropped. Real pain found → its phrases are proposed to the
   operator on `/radar` for approval; approved phrases are added to the trie.

### 6.4 4-Gate website audit (DOM-only in v1)
- **Gate 1 — Website dependency:** `depends_on_website = false` unless high-consideration
  inbound vertical, active ad pixels (`fbevents.js`, `gtag.js`), or ≥ 600 words of service
  content. False → record, but skip Gates 2–4 pitches.
- **Gate 2 — Outdated UI (heuristics only):** `<table>`-based layout, missing
  `<meta name="viewport">`, copyright year older than (current year − 3), wall-of-text
  paragraphs without container structure, legacy jQuery/Bootstrap versions (from tech-stack).
  `visual_modernity_score = null` (vision deferred to v1.1).
- **Gate 3 — Conversion & AEO/GEO:** forms with 8+ fields, no above-the-fold CTA, no
  testimonials/social proof, no JSON-LD, AI bots blocked in `robots.txt`, no `/llms.txt`.
- **Gate 4 — WhatsApp wedge:** 4A `missing_whatsapp_cta`, 4B raw `wa.me` link with no
  chat-widget script, else `automated_or_na`.

### 6.5 Contact extraction
Only public **business** contacts found on the site: role mailboxes (`info@`, `ops@`,
`sales@`, `contact@`…) and the public business WhatsApp/phone. Store with
`contact_source_url`. Never store named individuals' emails or numbers. No enrichment.

**One exception — founders/owners (Q49, Q49a):** store the founder's or owner's **name,
public role and email address** when they appear publicly in **their own post** or on the
**company website** (contact, about or team page), with the source URL. Only the founder or
owner — never other staff listed on a team page, and never the author of an employee post
(§4.1a). **No phone numbers.** Drafts can then
address the founder by name and be sent to their address when found, otherwise to the role
mailbox.

### 6.6 Information-silo / RAG track

**Seed phrases** (category `INFORMATION_SILO` unless noted; validated per §6.3):

| Source | Phrases | v1? |
|---|---|---|
| Job posts | "create and maintain SOPs", "organize company drive", "training coordinator", "documenting procedures", "centralize company documentation" | yes |
| Founder posts | "spend half my day answering questions", "trying to organize our company Notion", "team keeps asking the same questions" | yes |
| Employee reviews | "no SOPs", "training is terrible", "nobody knows where anything is", "scattered across emails and drives", "rely on the owner for everything", "information silo" | later (reviews out of v1) |

**Founder-dependency rule (Q44, Q44a):** any `INFORMATION_SILO` match **or** any
`OWNER_DEPENDENCY` match ("rely on the owner for everything", "spend half my day answering
questions", "only the founder knows") → middleware sets `founder_dependency_flag = true`
(+10 to B, applied **once** even if both match). Deterministic; the LLM cannot override it.

**Extraction guidance (Q46)**, added to the `StructuredIntelligence` prompt:
- `department`: `HR & Admin` or `Operations`.
- `verified_symptom`: category is "staff lack centralized documentation and rely on the owner
  or scattered files for answers and training", but the text **must describe this company's
  own evidence** (e.g. "Hiring an Ops Assistant to digitize physical files and write sales
  SOPs"). Never the generic sentence verbatim.
- `proposed_ai_replacement`: centralized AI knowledge base (RAG) over the company's physical
  and digital documents, acting as a 24/7 internal training and retrieval agent.

**Fixtures:**
- **A (job post, relabelled from `linkedin_job`):** "We are seeking an Operations Assistant.
  Your main duties will be to organize the company drive, create and maintain SOPs for the
  sales team, and ensure physical copies are digitized." *Expect:* passes the gate (≥ 2
  atoms), `founder_dependency_flag = true`, RAG replacement, symptom mentions digitizing
  files / sales SOPs, score ≈ **76 alone (Triage, > 70)** and ≈ **86 once a website signal
  adds M = +10**.
- **B (employee review snippet):** kept for when reviews enter scope; not run in v1.
- **C (founder post):** "Honestly I spend half my day answering questions my team should be
  able to look up." *Expect:* `linkedin_post`, flag true, RAG replacement.

### 6.7 Company size and recruiter filters

Size is checked after entity resolution and **before the company is created or its site
scraped**. No search is spent on size (Q56): the LinkedIn company search found a size in only
12 % of cases in Sprint 0.

1. **Employee count**, free sources only: the job board's own field (Indeed
   `employer.employeesCount`, given for ~44 % of US posts, 10–14 % IN/UAE); a range in the
   resolve-search snippets if one happens to appear; `known_large_brand` from extraction
   (§5.1 step 4) drops widely known 1,000+ companies.
2. **Company age**, free: the domain's registration date via RDAP — only when employee count
   is unknown.
3. Rules:

   | Employee count | Company age | Result |
   |---|---|---|
   | ≥ 1,000 | any | **Drop** |
   | 2–249 | any | **SMB** |
   | 250–999 | any | **Mid-size** |
   | unknown | < 4 years | **Startup** |
   | unknown | 4 to < 6 years | **Growth** |
   | unknown | ≥ 6 years or unknown | **Size unknown** (keep) |

   Domain age is only used to tag young companies. It never drops a company: in the
   Sprint 0 search test, ordinary SMBs had domains registered in 1997, 2002 and 2008
   ([sprint0-search.md](sprint0-search.md)). The worker asks each registry's own RDAP server
   from the IANA bootstrap file (not the rdap.org relay, which returned 403 for some `.org`),
   once per domain (the date is stored on the company). Measured 2026-11-04 on the 49 Sprint 0
   websites: 42 dated; `.ae` and `.co` have no RDAP server → age unknown. A failed lookup
   leaves the size unknown and never blocks the card.

4. Size tags show on the card. They do not change the score.

**Recruiters:** drop posts matching `RECRUITER` atoms ("our client", "on behalf of",
"staffing", "placement") or posted by firms on a staffing blocklist. Companies the operator
rejects as "wrong company" with a recruiter note are added to the blocklist.

## 7. Scoring

```
signal_score(s) = round(0.35·E(s) + 0.35·I(s) + B(s))      B(s) = 0 if s ∈ {dom_sniff, tech_stack}
families        = distinct source_family over the company's challenges
M               = 0 if |families| = 1; 10 if 2; 15 if ≥ 3
company_score   = min(100, max_s signal_score(s) + M)

if any inbound challenge exists → company_score = 100

B(s) (blast radius, 0–30, from the LLM's BlastRadiusHypothesis — v2.1 §4.3):
  frequency: Daily 10 · Weekly 5 · Sporadic 0
  urgency:   Blocking 10 · Nuisance 3
  founder_dependency_flag: true 10 · false 0   (forced true by the §6.6 rule)
```

Check: fixture A (job post, Weekly + Nuisance + founder flag) → B = 18 →
round(31.5 + 26.25 + 18) = **76**, as §6.6 expects.

- **Best single signal**, not best-E plus best-I from different signals.
- **Source families:** `dom_sniff` and `tech_stack` come from the same website fetch, so they
  count as one family (`website`) for M. See §13, item 1.
- Recompute in the same transaction as every challenge insert. Store the inputs in
  `score_breakdown` (`{best_signal_id, E, I, B, families, M, override}`).
- A new challenge on a company with a draft sets `draft_stale = true`.

Resulting behaviour (no inbound):

| Evidence | Score | Column |
|---|---|---|
| Website only | ≤ 44 | hidden |
| Job post only | 58–88 (by B) | Nurture if B ≤ 12, else Triage |
| Job post + website | 68–98 | Triage unless B ≤ 2 |
| Founder post (LinkedIn) only | 61–91 (by B) | Nurture if B ≤ 9, else Triage |
| Company-page post (LinkedIn) only | 56–86 (by B) | Nurture if B ≤ 14, else Triage |
| Employee post (LinkedIn) only | 51–81 (by B) | Nurture if B ≤ 19, else Triage |
| Employee post (Reddit) only | 47–77 (by B) | hidden if B ≤ 2, Nurture to B 23, else Triage |

Thresholds: **Triage > 70**, **Nurture 50–70**, hidden < 50.

## 8. `/roast` — "Roast My Stack"

### 8.1 Flow
Public page: URL + **work email** + Cloudflare Turnstile. `onBlur` on the URL field runs only
the SSRF/DNS check and a lightweight reachability probe — the full audit starts after submit
and Turnstile verification. The worker runs the sniff (§5.4) + a `MODEL_ROAST` teardown (OpenRouter, Q52) shown to the
visitor, then **upserts** the company on canonical domain and inserts an `inbound` challenge.

- Email domain matches site domain → verified inbound: score 100, `status` reset to `new`.
- Free-mail or mismatched domain → **Unverified inbound** badge, score 100, and **no status
  reset** on a previously actioned/rejected company.
- The board updates live via Supabase Realtime.

### 8.2 Guards (all required)
- Resolve DNS; block private, loopback, link-local, and metadata ranges (re-check after
  redirects). `http`/`https` only.
- Response size cap 2 MB; total timeout 8 s; max 3 redirects.
- Rate limit 5/hour per IP (`rate_hits` table, Q63); global daily cap on roasts (counts against spend).
- Turnstile token verified server-side.

## 9. Drafts

- Generated by `MODEL_DRAFTS` via OpenRouter (starting pick: a strong writing model such as
  Gemini Pro-tier), from the company's full evidence.
- **On demand only:** a "Generate draft" button on every card's drawer, Triage or Nurture.
  Nothing is generated automatically, and opening the drawer never triggers generation.
- When a founder name is known (§6.5), the emails address them by name.
- **No-website companies (§5.1 step 5d):** the emails pitch the work the job post is hiring
  for (the manual task, the hours, the automation that replaces it), never a website or a
  website audit; contact is through the job post.
- **Employee-post evidence is never quoted or referred to** (§4.1a, Q61): the draft
  prompt receives it as "pattern observed", without the URL, and the prompt forbids
  mentioning a post, an employee or "your team said". Founder and company-page posts may be
  referenced.
- One call returns **three emails** (subject + body each), one per strategy:
  `direct_active_intent`, `peer_benchmark_question`, `educational_value_first`. The one that
  fits the evidence is marked **recommended** (direct for job-post intent; educational when
  the strongest evidence is structural; peer-benchmark for mid-confidence matches).
- Each email has a **Copy** button. Copying does not change status.
- New evidence → `draft_stale = true` → drawer shows the draft with a "Regenerate" prompt.

```ts
// Zod (shape, not final code)
OutreachEmail = { strategy: OutreachStrategy, subject: string.max(120), body: string }
OutreachDrafts = { recommended: OutreachStrategy, emails: OutreachEmail[3], warning_banner?: string }
```

`StructuredIntelligence` = v2.1 §9 **minus** `outreach_draft`. `WebUiAndConversionAudit` and
`AnonymousTrendExtraction` as v2.1, ported to Zod.

## 10. UI

Mouse-driven. Dense, Swiss-minimal, dark default. No keyboard shortcuts in v1.

### 10.1 `/dashboard` — Triage inbox (Q67)

Three panes, email-client style. Kanban was dropped: columns are derived from the score, so
cards never move by hand, and narrow cards are too small to read evidence.

```
┌──────────┬────────────────────────┬──────────────────────────────────────┐
│ QUEUES   │ TRIAGE · 12   [sort ▾] │ acme-trading.ae           86 Triage  │
│▸Triage 12│ ● acme-trading.ae   86 │ Logistics · UAE · SMB · Job+Website  │
│ Nurture 9│   Logistics · UAE · SMB│ PAIN / PITCH / EVIDENCE / AUDIT /    │
│ Sent    31│ ○ zahr-freight.com  81 │ DRAFTS                               │
│ Rejected 7│ ○ diamondbraces.com 77 │                                      │
│ FILTERS  │ …                      │ [Generate drafts] [Sent] [Reject ▾]  │
└──────────┴────────────────────────┴──────────────────────────────────────┘
```

- **Left — queues and filters.** Queues with live counts: **Triage** (`status = new`,
  score > 70), **Nurture** (`new`, 50–70), **Sent** (`actioned`), **Rejected**. Score < 50
  stays hidden (shown only on `/radar`). Filters: vertical, country, size tag, pain type
  (labor arbitrage, integration debt, document friction, information silo, web/WhatsApp —
  from the matched atom categories), source family, badge. Queue and filters live in the
  URL so a view can be bookmarked.
- **Middle — ranked list.** Sorted by score (default) or newest evidence. Each row: domain,
  score, vertical · country · size tag, source-family icons, top amber badge. Selected row is
  highlighted; the list keeps its scroll position. Virtualized past 50 rows.
- **Right — dossier** (the old drawer, now always visible): header with score breakdown
  (best signal, M, families); then sections in the order the operator reads them —
  **Pain** (verified symptom, frequency · urgency · founder dependency), **Pitch** (proposed
  AI replacement), **Evidence**, **Website audit**, **Drafts** — and a sticky action bar.
- **After an action** (Sent / Reject) the next company in the list opens automatically, so a
  daily review is a straight run down the queue.
- **Amber badges** (row and dossier header):
  - **⚠ Single signal** — M = 0 (job post with no website corroboration yet).
  - **⚠ Unverified inbound** — §8.1.
  - **⚠ Client-rendered site** — audit limited by SPA guard.
  - **⚠ Snippet only — read the post** — LinkedIn evidence (§4.1a).
  - **⚠ Employee post — don't quote** — evidence from a current employee (§4.1a, Q61).
- **Size tag** on every row: **SMB**, **Mid-size**, **Startup**, **Growth**, or **Size unknown**.
- **Responsive:** below 1024 px the panes collapse to list → dossier (back button); below
  768 px queues move into a top menu.
- **Visual style:** dense, Swiss-minimal, dark default with a light theme; one sans family
  (Plus Jakarta Sans), tabular figures for scores; semantic colour tokens only; icons from
  one set (Phosphor). Colour never carries meaning alone — badges have icon + text.

### 10.2 Dossier sections
- **Evidence:** every challenge, newest first, with its `posted_at` age; Proof Viewer
  highlights semantic nodes and matched keywords in context; link to source (employee posts:
  link only, never quoted in drafts).
- **Website audit:** Gate 1–4 results, tech stack, contacts.
- **Drafts:** three emails, recommended marked, Copy buttons, Generate / Regenerate.
- **Actions:** **Mark as sent** → `actioned`. **Reject** → reason dropdown (wrong company,
  not a real pain, too small, already a client, other) → hidden. Both show an undo toast
  for 5 s.

### 10.3 Resurfacing
- Actioned company + new evidence → stays actioned; evidence attached.
- Rejected company + new evidence → back to `new` with a **New evidence** tag only if the new
  challenge's source family was not present at rejection **and** score rose ≥ 10 versus
  `rejected_score`. Verified inbound always resurfaces (§8.1).

### 10.4 `/radar` — telemetry (minimal in Sprint 3)
Funnel bars (raw → dedup → trie → resolved → extracted → on board), spend per provider vs
cap, pg-boss queue depth and failed jobs, pending seeds, **[Run Now]** (next 100 seeds).

### 10.5 `/trends` (Sprint 4) and `/roast` (public)

## 11. Data model

```sql
create extension if not exists pgcrypto;
create extension if not exists vector;

create table companies (
  id uuid primary key default gen_random_uuid(),
  domain text unique,              -- null = no website found (migration 0005)
  name_key text unique,            -- '<country>:<normalized name>:<city>'; domain or name_key required
  company_name text,
  vertical text,
  country text,
  contact_email text,            -- role mailbox only
  contact_whatsapp text,         -- public business number only
  contact_source_url text,
  founder_name text,             -- founder/owner only (Q49a)
  founder_email text,            -- only if publicly listed by them or on the company site
  founder_source_url text,
  reachable boolean,
  is_client_rendered boolean not null default false,
  employee_band text,            -- e.g. '11-50', as reported
  size_tier text check (size_tier in ('smb','midsize','startup','growth','unknown')),
  size_source text check (size_source in
    ('job_board','search_snippet','llm_brand','domain_age','none')),
  founded_year integer,          -- only if a source states it; never derived from domain age
  domain_registered_at date,     -- RDAP registration date (Q57: tags Startup/Growth only)
  tech_stack jsonb not null default '[]',
  structural_flags jsonb not null default '{}',
  web_ui_audit_flags jsonb not null default '{}',
  company_dossier_summary jsonb not null default '{}',
  priority_score integer not null default 0 check (priority_score between 0 and 100),
  score_breakdown jsonb not null default '{}',
  status text not null default 'new' check (status in ('new','actioned','rejected')),
  rejection_reason text check (rejection_reason in
    ('wrong_company','not_real_pain','too_small','already_client','other')),
  rejected_score integer,
  rejected_families jsonb not null default '[]',
  has_unverified_inbound boolean not null default false,
  resurfaced_at timestamptz,
  outreach_drafts jsonb,
  draft_stale boolean not null default false,
  draft_generated_at timestamptz,
  last_sniffed_at timestamptz,
  actioned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_companies_board on companies (status, priority_score desc, updated_at desc);

create table challenges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  source_type text not null check (source_type in
    ('job_post','linkedin_post','social_post','dom_sniff','tech_stack','inbound')),
  source_family text generated always as (
    case when source_type in ('dom_sniff','tech_stack') then 'website' else source_type end
  ) stored,
  natural_id text unique,
  source_url text,
  evidence_confidence integer not null,
  buying_intent integer not null,
  blast_radius integer not null default 0 check (blast_radius between 0 and 30),
  signal_score integer not null check (signal_score between 0 and 100),
  department text not null default 'Unknown',
  posted_at timestamptz,          -- signal's own publish date (§4.3); null only for inbound
  evidence_snippet text not null check (char_length(evidence_snippet) <= 2000),
  matched_keywords jsonb not null default '[]',
  semantic_nodes jsonb not null default '[]',
  structured_intelligence jsonb,   -- null for structural signals
  llm_model text,                  -- model slug that produced structured_intelligence
  inbound_verified boolean,
  author_relation text check (author_relation in
    ('founder_owner','employee','company_page')),   -- LinkedIn/Reddit only (Q59)
  author_name text,                -- founder_owner only (Q49); never for employee (Q61)
  author_role text,                -- founder_owner only
  author_email text,               -- founder_owner only, if in the post itself
  created_at timestamptz not null default now()
);
create index idx_challenges_company on challenges (company_id, created_at desc);

create table seed_urls (
  id uuid primary key default gen_random_uuid(),
  domain text unique not null,
  company_id uuid references companies(id) on delete cascade,
  origin text not null check (origin in ('job_post','linkedin_post','social_post','inbound')),
  status text not null default 'pending'
    check (status in ('pending','processing','done','unreachable','failed')),
  attempts integer not null default 0,
  last_error text,
  attempted_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_seed_urls_pending on seed_urls (status, created_at);

create table ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  vertical text,
  country text,
  apify_run_id text,
  status text not null default 'running',
  raw_items_ingested integer not null default 0,
  dropped_stale_count integer not null default 0,
  dropped_dedup_count integer not null default 0,
  dropped_trie_count integer not null default 0,
  dropped_recruiter_count integer not null default 0,
  dropped_unresolved_count integer not null default 0,
  dropped_size_count integer not null default 0,
  dropped_stance_count integer not null default 0,
  dropped_no_fit_count integer not null default 0,
  llm_persisted_count integer not null default 0,
  estimated_cost_usd numeric(8,4) not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table spend_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('apify','brave','openrouter','gemini')),
  model text,                    -- LLM model slug, when provider = 'openrouter'
  units numeric not null,
  cost_usd numeric(10,6) not null,
  run_id uuid references ingestion_runs(id) on delete set null,
  ref text,
  created_at timestamptz not null default now()
);
create index idx_spend_events_month on spend_events (created_at);

-- Q63: Postgres in place of Redis
create table seen_items (
  natural_id text primary key,        -- 'job:<id>', 'post:<url>', …
  expires_at timestamptz not null
);
create index idx_seen_items_expiry on seen_items (expires_at);

create table domain_cache (
  key text primary key,               -- '<normalized_name>:<city|vertical>'
  domain text,                        -- null = cached miss
  expires_at timestamptz not null     -- hit 30 d, miss 7 d
);

create table spend_counters (
  key text primary key,               -- 'month:2026-11', 'apify:2026-10-16'
  total_usd numeric(10,6) not null default 0,
  cap_usd numeric(10,2) not null,
  updated_at timestamptz not null default now()
);

create table rate_hits (
  bucket text not null,               -- 'roast:<ip>'
  hit_at timestamptz not null default now()
);
create index idx_rate_hits on rate_hits (bucket, hit_at);
-- Daily cleanup job deletes expired seen_items / domain_cache rows and rate_hits older than 1 day.

-- Sprint 4: trend_clusters and macro_trends as in v2.1 §10 (vector(768), HNSW m=16, ef_construction=64).
```

**RLS:** enabled on every table. `authenticated` may `select` all. On `companies`,
`authenticated` gets column-level `update` on `status`, `rejection_reason`, `actioned_at` only.
Everything else is written by the worker with the service role. Draft generation from the UI
goes through an API route that enqueues a job.

## 12. Verify before coding

Per the build rules: confirm against the live service and one real response, never an
imagined payload.

1. ✅ *Done 2026-11-03* — [sprint0-boards.md](sprint0-boards.md). **Job-board actors** for every §4.1 candidate: existence, input schema, whether output
   includes company size, per-result price, free-credit behaviour. Then the **50-posts-per-
   board-per-market** measurement → board comparison table + **$/month table**.
1a. **Reddit Apify actor:** shortlist by price — `fatihtahta/reddit-scraper-search-fast`
   ($0.00149/post), `clearpath/reddit-search-scraper` ($0.00099/post + $0.00099/run),
   `automation-lab/reddit-scraper` ($0.00115/post + $0.003/run); must support a date filter
   (§4.3). Pick one; input (subreddits, keywords), output fields, price.
1b. ✅ *Apify half done 2026-11-03* — [sprint0-search.md](sprint0-search.md); Brave half
   deferred until a Brave key exists. **Search provider (Q53):** Brave API vs an Apify Google Search actor, on the same set of
   ~30 entity-resolution queries and ~20 LinkedIn `site:` queries. Compare: correct domain
   rate, snippet quality, cost per query, latency (Apify runs are batched). Brave account is
   created only if Brave wins. Everything in this PRD that says "Brave" means "the chosen
   search provider".
1c. ✅ *Done 2026-11-04* — [sprint0-search.md](sprint0-search.md#q62--openrouter-web-search-run-2026-11-04): 38/60 found vs 29/60, $0.0018 per company, **adopted as the resolver**. **OpenRouter web search** (Q62) as a third resolver: `web` plugin, engine Parallel
   (turbo/fast $0.001 per request, up to 10 results; results also billed as prompt tokens)
   on the same 60 companies. Billed to OpenRouter, not Apify — if accuracy matches, company
   search moves off the Apify cap. LinkedIn post discovery stays on Apify Google Search
   (needs `site:` + date filter).
2. ✅ *Done 2026-11-03* — **Apify webhook** payload shape and secret header: payload `resource` is the
   run object (`id`, `defaultDatasetId`, `chargedEventCounts`); non-2xx is retried with backoff up to
   11 times; secret via `headersTemplate` on a persistent webhook (§5.1 step 1). Indeed actor
   verified on 125 real items: `employer.name` 92 %, `corporateWebsite` 43 %, `employeesCount` 38 %,
   `datePublished` 100 %; price $0.0001/item + $0.001/start; datasets kept 7 days on the free plan.
3. **Brave Search API:** current plan, price per query, rate limit, and whether
   `extra_snippets` is available on that plan.
4. **OpenRouter:** pick a slug for each task (`MODEL_EXTRACTION`, `MODEL_DRAFTS`,
   `MODEL_ROAST`); confirm each supports structured JSON output through OpenRouter; record
   price, rate limit, the per-request cost field, and OpenRouter's fee on credit purchases.
   Compare 2–3 candidates per task on the same fixtures before pinning.
5. **Gemini embeddings:** `gemini-embedding-001` with `outputDimensionality: 768` (Sprint 4).
6. **`enthec/webappanalyzer`:** maintenance activity and licence (believed GPL-3.0 — fine for
   a private, undistributed tool; revisit before any SaaS distribution).
7. **pg-boss** with Supabase session pooler from Railway. ✅ *From local, 2026-11-03:* session
   pooler (eu-central-1, port 5432) connects; Postgres 17.11; advisory locks and LISTEN/NOTIFY
   work; `max_connections` = 60 → keep pools small (worker pg-boss max 5, web max 3). `vector`
   available, created by the first migration. Re-check from Railway at deploy.
8. **Next.js** current stable version (v2.1 said 14; use current).

## 13. Open items

Settled (approved 2026-11-02):
1. **M counts source families, not raw source types** (§7) — `dom_sniff` + `tech_stack` are
   one family (`website`).
2. **Amber badges** are *Single signal*, *Unverified inbound*, *Client-rendered site*
   (v2.1's "Structural Only" badge could never appear).
3. **Seed sniffs run automatically** (§4.2); [Run Now] forces the next 100.

4. **Unknown-size rule** — settled in §6.7 (Q41a–d).
5. **Founder-post gate** is ≥ 1 pain atom (vs ≥ 2 for job posts), because snippets are short;
   the stance check (§4.1a) catches the extra false positives.

No open items.

## 14. Decision log

| # | Question | Decision |
|---|---|---|
| Q1 | Operator model | One operator, one agency, no multi-tenancy |
| Q2 | Budget scope | $20/mo variable API spend only; infra on Railway separately |
| Q3 | Language | TypeScript + Zod |
| Q4 | v1 sources | Job posts + website sniffs of resolved domains + `/roast` (via Q24) |
| Q5 | Web Unlocker | Dropped; 403 → unreachable |
| Q6 | Spec docs | PRD v2.1 supplied |
| Q7 | Who builds | Claude is the developer; Sprints 1–3 = MVP, Sprint 4 stretch |
| Q8 | Card unit | Company; challenges are evidence rows |
| Q9 | Blast radius guard | B = 0 for `dom_sniff` and `tech_stack` |
| Q10 | Columns | Score band + status; < 50 hidden; rejected hidden (bands revised by Q44b) |
| Q11 | Draft in extraction | Removed; lazy drafting |
| Q12 | Models | Retired v2.1 models replaced; generic tiers in docs, verified IDs in code (drafts moved to Gemini Pro by Q44b) |
| Q13 | Dedup | 30-day dedup on natural ID; search results cached (Postgres since Q63) |
| Q14 | Webhook | Receives `datasetId`; worker pages items |
| Q15 | Compliance | IN, UAE, US, SEA; public business contacts only; WhatsApp for replies/opt-ins |
| Q16 | Queue | pg-boss + worker service |
| Q17 | Company score | Best single signal + M; recompute in-transaction |
| Q18 | Draft timing | Superseded by Q44b: on demand only; never on drawer open; stale flag |
| Q19 | Resurfacing | Actioned stays; rejected resurfaces on new family + ≥ 10 points |
| Q20 | Seeds | Signal-driven only; no directory, Maps or CSV |
| Q20′ | Boards / verticals | Verticals expanded to 16 by Q54; boards initially Indeed + Naukri, now chosen by measurement (Q50) |
| Q21 | `/roast` guards | All four (SSRF, caps, rate limits, Turnstile) |
| Q22 | Approve action | No send/handoff; drafts shown with Copy buttons |
| Q22a | Three formats | Three emails by strategy, one recommended |
| Q22b | Leaving the board | Mark as sent, Reject + reason |
| Q23 | Gate 2 vision | Deferred to v1.1; DOM heuristics only |
| Q24 | Structural signals | Corroboration only; job posts are the spine |
| Q25 | Keyword tries | Mined from real posts; recall-gated |
| Q26 | Scheduling | pg-boss cron |
| Q27 | Rate limiting | Per-dependency queues; spend cap pauses paid queues |
| Q28 | Inbound score | Hard 100; upsert on domain; status reset |
| Q28′ | Inbound spoofing | Work email required; mismatch → Unverified badge, no reset |
| Q29 | Labelling | LLM pre-labels, operator corrects |
| Q30 | Sprint 4 | Minimal telemetry → Sprint 3; clustering Sprint 4; reverse sniff Phase 2 |
| Q31 | Shortcuts | None in v1 |
| Q32 | Auth | Supabase email/password |
| Q33 | Reviews | Out of v1; Shadow IT from tech-stack sniff |
| Q34 | CSV upload | None |
| Q35 | Accounts | Have: Railway, Supabase, Apify. Need: see §16 |
| Q36 | Recall gate size | 320 labelled posts (20 per vertical, Q54); ≥ 85 % pooled, ≥ 70 % per vertical |
| Q37 | Volume | Daily rotation; size set by verified pricing |
| Q37′ | Indeed countries | UAE + US |
| Q38 | Deliverable | This file |
| Q39 | Reverse stack-sniff | Phase 2 via HTTP Archive (BigQuery), after a coverage check |
| Q40 | Size range | 2–999 employees; SMB / Mid-size tags; no score effect |
| Q41 | Unknown size | Judge by company age (full table §6.7) |
| Q42 | Recruiters | Dropped via `RECRUITER` atoms + staffing blocklist, before resolution |
| Q43 | Founder posts | In v1: LinkedIn (Brave snippets) and Reddit; reviews stay out |
| Q44 | Founder flag | Information-silo or owner-dependency evidence sets it (Q44a) |
| Q45 | Fixture A | ≈ 76 alone, ≈ 86 with website corroboration (both Triage under Q44b) |
| Q46 | Symptom text | Category guidance; symptom must cite the company's own evidence |
| Q47 | Job-post gate | ≥ 2 atoms across AUTOMATABLE_TASK, INFORMATION_SILO, DOCUMENT_FRICTION |
| Q48 | Reddit attribution | Card only if post names company or links site; else trends track |
| Q49 | Founder identity | Store post URL, snippet, company, author name and role |
| Q50 | Job boards | Measure 50 posts per candidate board per market; pick by the numbers |
| Q41a | Known size | Q40 governs: 2–999 kept at any age |
| Q41b | Age 4–6, size unknown | Tagged "Growth" |
| Q41c | Age 6–8, size unknown | Tagged SMB — superseded by Q57 |
| Q41d | Age > 8, size unknown | Dropped before any scraping — superseded by Q57 |
| Q44a | Founder flag trigger | Either evidence type sets it; +10 once |
| Q44b | Triage + drafts | Triage > 70, Nurture 50–70; drafts on demand only via Generate; drafts on Gemini Pro (OpenRouter removed) |
| Q49a | Founder email | Founder/owner name + email if public in their own post or on the company site; no staff; no phones |
| Q53 | Search & Reddit | Reddit via Apify actor; search provider (Brave vs Apify Google Search) decided by Sprint 0 comparison |
| Q52 | LLM provider | OpenRouter for all LLM text tasks, one model setting per task; Gemini direct for embeddings only (supersedes the drafts-on-Gemini part of Q44b) |
| Q51 | Short LinkedIn snippets | Snippet + Brave extra snippets; LLM stance check (suffering/selling/commenting), only "suffering" kept, also on Reddit; "Snippet only" badge; full text sent to the LLM for posts under ~1,500 words |
| Q54 | More verticals | 16 verticals with a market matrix (45 slots, §4.1b); rotation 4 slots/day × 50 posts (same daily volume); low-yield slots thinned automatically; labelled set 320 posts; phrase mining in 20-post batches per vertical, tested after each, more batches only for failing verticals (max 5); daily 2 % leak check on dropped posts; reliability rules in §5.3a |
| Q55 | Freshness | Only signals posted in the last 21 days; source date filters + worker re-check; undated items dropped unless source-filtered; company facts (site, size, domain age) not age-filtered (§4.3) |
| Q57 | Domain age | Only tags Startup (< 4 y) / Growth (4–6 y); older or unknown → "Size unknown", kept; never drops (supersedes Q41c, Q41d) |
| Q56 | Search cost | Board website first; extraction LLM before any search, drop no-fit / known large brands; no LinkedIn size search; daily search quota (15), highest score first; Brave compared later |
| Q58 | Apify ≤ $5 | Indeed only (Naukri/Naukrigulf off); 3 slots × 35 posts/day; Apify cycle cap $4.50 with daily reconcile against Apify's own usage; budget split in §5.3 |
| Q59 | LinkedIn authors | Founder/owner, current employee, company page; drop vendor, commentator, former employee, recruiter; author_relation + stance check |
| Q60 | Company-post scoring | LinkedIn: founder 85/90, company page 80/80, employee 80/65; Reddit: founder 75/85, employee 75/60 (E/I) |
| Q61 | Employee protection | No employee name/role/email stored; drafts never mention the employee or their post; "Employee post — don't quote" badge |
| Q63 | Redis | No Upstash in v1: dedup, domain cache, spend counters, rate limits are Postgres tables; spend check is one atomic UPDATE; Redis is a scale-up option (§18) |
| Q64 | Raw archive | Raw items (personal fields stripped) kept 21 days in Supabase Storage for re-runs; Sprint 2 |
| Q65 | Ops kit | CI (typecheck + tests) in Sprint 1; Sentry + daily alert email in Sprint 2 |
| Q66 | Provider interfaces | Every external service behind an interface with a test fake; business logic never imports a provider SDK |
| Q67 | Main UI layout | Three-pane triage inbox (queues · ranked list · dossier) replaces Kanban; next company opens after each action |

## 15. Sprint plan

Build order: a **walking skeleton** first — every layer thin but real, seeded with the real
Sprint 0 data so the UI is judged on real cards from day one — then fill in each layer.

| Layer | Contents | Tests |
|---|---|---|
| UI | Board, drawer, `/radar`, `/roast` | One click-through test on seeded data |
| Application | pg-boss jobs, queues, retries, budget gates | Integration tests with fake providers |
| Business rules | Scoring, trie gate, size rules, freshness, stance, budget split | Pure functions, unit tests (most tests live here) |
| Data | Supabase schema, migrations, RLS, repositories | Against a local Supabase |
| Integrations | Apify, OpenRouter, search, RDAP — each behind a small interface | Fake in tests, real in production |

Shared Zod schemas (`StructuredIntelligence`, `ScoreBreakdown`, job payloads) are the
contract between worker and UI.

**Sprint 0 — verification.** ✅ Job-board measurement, Apify search test, freshness check
(2026-11-03). Remaining: Reddit actor pick (§12 1a), Apify webhook payload, OpenRouter model
comparison (extraction + drafts), webappanalyzer licence, pg-boss on the Supabase session
pooler, Next.js version. Brave comparison waits for a key.

**Sprint 1 — walking skeleton.**
1. Repo (web + worker + shared package), Railway services, env wiring.
2. Supabase schema + migrations + RLS; single-user auth.
3. Shared Zod contracts; business layer as pure functions — scoring (§7), size rules (§6.7),
   freshness (§4.3), budget gates (§5.3) — with unit tests.
4. **Seed script:** loads `data/sprint0/` through the real scoring code into the database.
5. **Plain triage inbox** (queues, ranked list, dossier) reading the real database (no polish yet).
6. pg-boss + worker; Apify cycle cap and spend counter (any real run costs money, so the
   guard comes before the first run).
7. GitHub Actions: typecheck + unit + integration tests on every push (Q65).
8. One real Indeed run end to end: webhook → `fetch-dataset` → freshness → dedup → minimal
   trie → extract → resolve → size → score → card.
*Acceptance:* seeded inbox shows ~60 real companies in the right queues; one real Indeed
post becomes a scored card; webhook returns 202 in < 2 s; RLS denies anon reads and operator
writes outside allowed columns; a test proves the Apify gate refuses a run that would cross
the cap.

**Sprint 2 — real data quality.**
Phrase mining in 20-post batches + labelled set (§6.3); full tries for 16 verticals incl.
information-silo and recruiter categories; `audit-dropped`; resolve queue with daily quota
and score ordering (§5.1); size filter; company posts (LinkedIn post search, Reddit actor) with author check;
Cheerio minify, SPA guard, Semantic Node Extraction; `sniff-domain` with tech-stack matcher
and 4-Gate (DOM); `seed_urls` + [Run Now]; `ingest-rotation` cron; daily Apify usage
reconcile; raw payload archive (Q64); Sentry + daily alert email (Q65). The operator
watches the board improve on real cards throughout.
*Acceptance:* recall gate met (§6.3); 1 MB HTML processed without error; name→domain
resolution correct on a 30-company spot check; projected Apify cycle spend ≤ $4.50 on
`/radar`.

**Sprint 3 — UI completion + drafts.**
Badges, Proof Viewer, Teardown card, three-email drafts with Copy, Mark as sent / Reject,
resurfacing rules, `/radar` telemetry.
*Acceptance:* operator can review evidence, generate and copy a draft, and action or reject
a company with the mouse alone; badges follow §10.1 rules; `/radar` spend matches provider
dashboards within 10 %.

**Sprint 4 — stretch.**
`/roast` with all guards + Realtime; Reddit anonymous track, embeddings, clustering,
`/trends`; fuller telemetry.
*Acceptance:* roast creates or updates the right company live; clusters group related
complaints on a hand-checked sample.

## 16. Setup checklist

| Service | Status | Needed for | Env vars (Railway + `.env.local`) |
|---|---|---|---|
| Railway | have | web + worker hosting | — |
| Supabase | have | DB, auth, Realtime, pg-boss | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (session, :5432) |
| Apify | have | job-post actors | `APIFY_TOKEN`, `APIFY_WEBHOOK_SECRET` |
| Brave Search API | **hold** — only if it wins the §12 item 1b comparison | entity resolution, LinkedIn snippets | `BRAVE_API_KEY` |
| OpenRouter | **create** | extraction, drafts, roast (all LLM text) | `OPENROUTER_API_KEY`, `MODEL_EXTRACTION`, `MODEL_DRAFTS`, `MODEL_ROAST` |
| Google AI Studio | **create** (Sprint 4) | embeddings only | `GEMINI_API_KEY` |
| Cloudflare Turnstile | **create** (Sprint 4) | `/roast` | `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` |
| Domain | **later** (Sprint 4) | public `/roast` | — |

Also: `MONTHLY_CAP_USD=20`, `ROAST_DAILY_CAP=20`. `APIFY_WEBHOOK_SECRET` is pre-generated in
`.env.local`. The full template lives in `.env.local` (git-ignored). Keys go into Railway variables and a local `.env.local`, never into
chat or source control.

## 17. Phase 2 and later

- Gate 2 vision score (v1.1) — Playwright screenshots, gated to Gate-1-pass companies ≥ 50.
- Employee SERP review snippets (v1.1) if many companies stall at 70–79.
- Reverse stack-sniff via HTTP Archive BigQuery, after a coverage check on real resolved
  domains.
- Additional sources: customer reviews, employee reviews, more job boards and SEA markets.
- Content Arbitrage SEO briefs and Upstream Vendor Reports.
- Keyboard shortcuts; outbound integration via signed webhook.

## 18. Scale path (technology decisions)

Reviewed and approved 2026-11-03 (Q64–Q66).

**How to read it.** Each row: what v1 uses, why, the options for later, and the **trigger** —
the measurable signal that says "switch now". The rule throughout: stay on the simplest option
until a trigger fires; never switch on a hunch. Prices of options not yet checked are left
out on purpose — each gets verified (PRD §12 rules) before it is chosen.

v1 load for reference: ~100 job posts/day, ~15 website searches/day, ~15 new cards/day,
1 operator, a few thousand jobs/day through the queue.

### 18.1 Compute and hosting

| Area | v1 | Why | Scale options | Switch when |
|---|---|---|---|---|
| Web + worker hosting | Railway, 2 services | One platform, long-running worker, no request timeouts | Vercel for web + Railway worker; Fly.io; Render; AWS ECS/Fargate or GCP Cloud Run | Worker CPU > 70 % sustained, or need multiple regions, or Railway cost > a managed alternative at same load |
| Worker scaling | 1 worker instance, per-queue concurrency | Simple; provider limits are the real bottleneck | Several worker replicas (pg-boss is safe for this); separate worker per queue group (scrape / LLM / sniff) | Queue backlog grows for > 1 day while providers still have headroom |
| Web framework | Next.js (current stable) | UI + thin API in one app | Split: Vite/React SPA + separate API service | Many non-UI API consumers (SaaS customers, integrations) |
| Language / validation | TypeScript + Zod | One language across web, worker, shared contracts | — (keep) | — |

### 18.2 Data

| Area | v1 | Why | Scale options | Switch when |
|---|---|---|---|---|
| Main database | Supabase Postgres (current plan) | Auth, RLS, Realtime, pgvector in one place | Supabase paid compute tiers; Neon; AWS RDS/Aurora; read replica for `/radar` and analytics | DB CPU > 60 % sustained, storage near plan limit, or `/radar` queries slow the pipeline |
| Connections | Session pooler :5432; small pools (worker 5, web 3) of `max_connections` 60 | pg-boss needs session mode | Transaction pooler :6543 for the web app only; bigger Supabase compute (more connections); dedicated pooler | Connection errors / pool waits, or more worker replicas |
| Large tables | Plain tables + indexes | Small volume | Partition `challenges` / `spend_events` by month; archive old rows to object storage | A table > ~10 M rows or index bloat slows writes |
| Dedup, caches, spend counters, rate limits | Postgres tables (Q63) | One system, transactional budget gate | **Redis** (Upstash or Railway Redis) for dedup/cache/rate limits; keep the budget gate in Postgres for its atomicity | > ~100 checks/second, or these tables become top DB load |
| Raw scraped payloads | Not kept (Apify storage expires) | Personal-data minimisation | Archive raw items in Supabase Storage / S3 for 21–30 days, personal fields stripped, to **re-run the pipeline** after keyword or prompt changes | First time we want to reprocess past data — likely Sprint 2 (see §9, Q64) |
| Vectors (trends, Sprint 4) | pgvector in Postgres, HNSW | No extra service | Dedicated vector DB (Qdrant, Pinecone, Weaviate) | > ~5–10 M vectors or vector queries slow the main DB |
| Analytics / reporting | SQL views for `/radar` | Enough for one operator | Warehouse (BigQuery, ClickHouse, MotherDuck) fed nightly | Cross-month funnel analysis or customer-facing reports |

### 18.3 Background work

| Area | v1 | Why | Scale options | Switch when |
|---|---|---|---|---|
| Job queue | pg-boss in Postgres | No extra infra; transactional enqueue | Graphile Worker (also Postgres); BullMQ + Redis; durable workflow engines (Temporal, Inngest, Trigger.dev); cloud queues (SQS, Cloud Tasks) | > ~1,000 jobs/minute, or long multi-step flows with human waits that are awkward as chained jobs |
| Scheduling | pg-boss cron (singleton) | Same system as the queue | Railway cron; workflow-engine schedules | Many schedules per tenant (SaaS) |
| Retries / failure handling | pg-boss retries + backoff, circuit breaker, failed jobs on `/radar` (§5.3a) | Enough at this size | Dead-letter queue with replay UI; per-provider rate-limit service | Failed-job volume needs triage tooling |

### 18.4 Data acquisition

| Area | v1 | Why | Scale options | Switch when |
|---|---|---|---|---|
| Job posts | Apify `valig/indeed-jobs-scraper`, Indeed only, 3 markets | Best measured quality, $0.0001/post | Re-enable Naukri / Naukrigulf (tested); Apify paid plan; licensed job-data APIs (e.g. TheirStack, Coresignal — **not yet evaluated**); own Playwright crawlers | Indeed actor fails repeatedly → fallback `curious_coder/indeed-scraper`; need volume beyond the $5 Apify cycle |
| Company website lookup | Apify Google Search, 15/day, LLM picks domain | Measured 48 % found, 2/29 wrong | **OpenRouter web search (Parallel, $0.001/request) — test pending (Q62)**; Brave Search API; other SERP APIs (Serper, SerpAPI — not yet evaluated); company-enrichment APIs | Q62 result; or daily quota leaves a lasting backlog of good posts |
| LinkedIn company posts | Apify Google Search `site:linkedin.com/posts` + 21-day filter, snippet only | Never touches LinkedIn directly | Brave (extra snippets); licensed social-listening data providers | Snippets too short to judge most posts, or volume need > ~3/day |
| Reddit | Apify Reddit actor (to pick, ~$0.001–0.0015/post) | No Reddit API account | Reddit's official API (needs app approval/terms review) | Volume or reliability need beyond the actor |
| Website fetch | Own SSRF-safe fetch (homepage + 3 pages) + Cheerio; SPA guard | Free, fast, controlled | Headless browser (Playwright on the worker, Browserless) for client-rendered sites; Firecrawl / Apify website crawler | "Client-rendered site" badge on > ~25 % of cards |
| Tech-stack detection | `enthec/webappanalyzer` fingerprints | Free, offline | Wappalyzer / BuiltWith paid APIs; HTTP Archive (Phase 2) | Detection misses matter for pitches, or licence issue for SaaS distribution |
| Domain age | Registry RDAP servers via the IANA bootstrap (free) | No key | Paid WHOIS API (for `.ae`, `.co`) | Age tags matter and `.ae` gaps hurt |

### 18.5 AI layer

| Area | v1 | Why | Scale options | Switch when |
|---|---|---|---|---|
| LLM access | OpenRouter, one model setting per task | Switch models by env var; one bill | Direct provider APIs for the hot path (lower latency, **batch APIs ~50 % cheaper**, prompt caching); keep OpenRouter for experiments | LLM spend > ~$15/month, or a batch discount would halve it, or OpenRouter outage risk matters |
| Extraction model | Cheap model (Haiku 5.5 candidate, comparison pending) | ~$0.0005/post | Batch mode overnight; smaller/faster models; fine-tuned small model on our labelled data | Volume ×10 or accuracy plateau |
| Drafts model | Strong writer, on demand (comparison pending) | Quality over cost; few calls | — | — |
| LLM observability | Cost + model stored per row; `/radar` | Enough for now | LLM tracing (Langfuse, Helicone, OpenRouter's own logs) with prompt versions and eval scores | Prompt changes need A/B comparison, or quality regressions appear |
| Evaluation | Labelled set (§6.3), recall gate, model comparison fixtures | Catches regressions | Automated eval suite in CI on every prompt/trie change | More than one person changes prompts |
| Embeddings | Gemini `gemini-embedding-001` @768 (Sprint 4) | Cheap, good | OpenAI / Voyage embeddings; local model | Cost or quality issue on trend clustering |

### 18.6 App platform

| Area | v1 | Why | Scale options | Switch when |
|---|---|---|---|---|
| Auth | Supabase auth, one operator, sign-ups off | Simplest | Teams/orgs table + per-tenant RLS; SSO (e.g. WorkOS) | Second user or first customer |
| Multi-tenancy | None | One agency | `org_id` on every table + RLS by org; per-tenant budgets and caps | Selling access to other agencies |
| Realtime board | Supabase Realtime (Sprint 4 `/roast`) | Built in | Polling / SSE | Realtime connection limits |
| Bot protection | Cloudflare Turnstile + `rate_hits` table | Free | Cloudflare WAF rate rules at the edge | `/roast` abuse |
| Outreach sending | **Out of scope** — copy only | Deliverability and compliance risk | Gmail/Outlook API sending from the operator's mailbox; dedicated cold-email tools with warm-up | Operator wants sending inside the app (needs its own compliance review) |

### 18.7 Operations

| Area | v1 | Why | Scale options | Switch when |
|---|---|---|---|---|
| Error tracking | Logs on Railway + failed jobs on `/radar` | Free | **Sentry** (free tier) for web + worker | Before go-live (cheap insurance — see Q65) |
| Logs / metrics | Railway logs | Free | BetterStack / Axiom logs; OpenTelemetry metrics | Need search over > a few days of logs |
| Alerts | `/radar` only | One operator checks daily | Email / Slack alert on: budget 80 %, actor failing, queue backlog, zero cards in 24 h | Before go-live (Q65) |
| CI / tests | Local Vitest + Playwright | Fast start | GitHub Actions: typecheck, unit, integration on every push; deploy only on green | Sprint 1 (Q65) |
| Environments | Local + production | One operator | Staging on Railway + Supabase branching | Before the first schema change on live data |
| Secrets | `.env.local` (chmod 600) + Railway variables | Simple | Doppler / Infisical / 1Password | Second developer or several environments |
| Backups | Supabase backups per plan — **verify what the current plan includes** (free tiers may not include restorable backups) | Built in where included | Point-in-time recovery (paid add-on); weekly logical dump to object storage | Data becomes business-critical |

### 18.8 Compliance (grows with scale)

| Area | v1 | Scale options | Switch when |
|---|---|---|---|
| Personal data | Business contacts only; founder name/email if self-published; no employee data (Q49, Q61); personal fields stripped at ingest | Data retention job (delete rejected/stale companies after N months); data-subject request process (India DPDP, UAE PDPL, US state laws) | First customer or any public launch |
| Scraping terms | Public data via Apify; LinkedIn via search snippets only; no bot-wall bypass | Licensed data providers instead of scrapers | Selling the product, or a source objects |

### 18.9 Added to v1 (Q64–Q66)
- **Raw payload archive (Q64, Sprint 2):** raw scraped items, personal fields stripped at
  ingest (§6.5), kept 21 days in Supabase Storage (`raw/{source}/{date}/{run_id}.json.gz`) so
  the pipeline can be re-run after keyword or prompt changes without paying Apify again. A
  daily job deletes archives older than 21 days.
- **Minimum operations kit (Q65):** GitHub Actions running typecheck + unit + integration
  tests on every push (Sprint 1); Sentry free tier on web + worker and one daily alert
  (email) for budget ≥ 80 %, a failing actor, or zero new cards in 24 h (Sprint 2).
- **Provider interfaces (Q66):** every external service — job source, search, LLM, RDAP,
  website fetch — sits behind a small interface in `packages/core` with a fake for tests.
  Business logic never imports a provider SDK directly.
