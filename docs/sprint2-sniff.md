# Sprint 2 — website sniff on real sites (2026-11-04)

`npm run sniff:test` runs the full sniff (PRD §5.4) on the 57 websites known for the Sprint 0
companies (board websites plus the ones the resolver found). Free: plain HTTP, no API.
Raw output: `data/sprint0/sniff-test.json` (git-ignored).

## Results (after the fixes below)

| | Result |
|---|---|
| Reachable | 47 / 57 (82 %). 6 blocked or timed out (403, 418, 429 bot walls; §5.4 says no unblocking); 4 redirect to another domain |
| Time per site | median 2.4 s, max 8.1 s (homepage + up to 3 pages + robots.txt + llms.txt) |
| Client-rendered (SPA guard) | 1 / 47 |
| Gate 1: website matters | 34 / 47 |
| **`dom_sniff` challenge** (manual intake) | **3 / 47 (6 %)**: 2 × no online booking (healthcare), 1 × email link only |
| **`tech_stack` challenge** (≥ 3 separate SaaS customer tools) | **0 / 47** |
| Gate 4 (IN/UAE sites) | no WhatsApp button 18 / 32, plain wa.me link 7 / 32 |
| Gate 3 | no reviews 22, no JSON-LD 20, long form 5, no CTA near top 3, AI crawlers blocked 0, no llms.txt 42 |
| Gate 2 | copyright ≥ 4 years old 6, table layout 1, no viewport 1, old jQuery/Bootstrap 0 |
| Contacts | role mailbox 28, phone 26, WhatsApp 7 |

**What this means.** Website challenges are rare (6 %), so the website rarely changes a score;
the audit mostly adds pitch material (WhatsApp, reviews, structured data) and contacts. That
matches §1: website findings are a foot in the door, never the main pitch. `no llms.txt` fires
on 89 % and says nothing about a company; it stays audit-only.

## Bugs the real sites found

1. **Hijacked domain audited as the company's.** `sasfny.org` redirects to a spam site. A
   homepage that redirects to another domain is now "not this company's site" (`reachable =
   false`, reason shown on the card). Three legitimate-looking rebrands are caught too
   (`smartdocsnow.com → smartdocs.ai`, `citadelfederalsolutions.com → falcontek.com`,
   `venturepipe.com → provensupply.com`); the card shows where it redirects.
2. **Script-rendered forms counted as "no form".** Ninja Forms builds its form after load; a
   form builder in the tech stack, or a link/embed to a hosted form (Typeform, Jotform,
   Google Forms…), now counts as a form. Took "email only" from 4 to 1.
3. **Browser-only fingerprints matched every page.** DOM fingerprints that check JS
   properties (React, Preact) were treated as present whenever the selector matched `body`.
   Rules that only check properties are skipped.
4. **1 MB page took 20 s**, 16.5 s of it in ~1,600 DOM selectors. A text pre-check skips
   selectors whose literals aren't in the HTML: same detections on 5 real sites, 1.5 s.

## Known limit

`healthcare` includes product sellers (`aakaarmedical.in` sells skincare), where "no online
booking" doesn't apply. The vertical comes from the job post; the sniff can't tell a clinic
from a shop. Reject as "not a real pain" if it shows up.
