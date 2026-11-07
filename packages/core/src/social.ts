// Social digest, LinkedIn half (PRD §4.1a): public LinkedIn posts found through Google search
// (site:linkedin.com/posts), snippet only — LinkedIn pages are never fetched. Reddit waits for
// the Sprint 4 trends track: a 2026-11-06 sample gave 0 posts naming a company.
import type { VerticalSlug } from "./verticals.ts";

// Topic search (§4.1a, revised 2026-11-06): the query names a work topic, never a phrasing, so a
// post is found however it starts — a complaint, a hiring post, a milestone. The AI judges the
// meaning afterwards (stance suffering or implied). Topics are short post words boiled down from
// each vertical's labelled keywords (§6.3, atoms.ts): job-ad wording ("accounts payable
// operations") is not how people post. 20 per vertical, 4 per run: 5 runs before a repeat. No
// one-word topics that name other things ("dispatch" matched newsletters, 2026-11-06).
export const SOCIAL_TOPICS: Record<VerticalSlug, readonly string[]> = {
  real_estate: ["rent collection", "lease renewals", "tenant screening", "maintenance requests", "property inspections", "tenant follow-ups", "leasing paperwork", "rent reminders", "move-in checklists", "closing documents", "listing updates", "owner statements", "property admin", "security deposits", "rent rolls", "vacancy tracking", "Trakheesi", "Ejari", "escrow paperwork", "showing schedules"],
  logistics: ["shipment tracking", "customs paperwork", "booking confirmations", "dispatcher", "bills of lading", "freight invoices", "track shipments", "schedule pickups", "proof of delivery", "rate confirmations", "load board", "customs clearance", "detention charges", "carrier payments", "delivery updates", "freight quotes", "shipping documents", "container tracking", "trucking paperwork", "dispatching loads"],
  accounting: ["bookkeeping", "bank reconciliation", "GST returns", "data entry", "month-end close", "payment reminders", "ledgers", "invoices", "accounts payable", "accounts receivable", "expense receipts", "payroll processing", "VAT returns", "tax filing", "client documents", "audit prep", "journal entries", "vendor bills", "cash flow reports", "Tally"],
  healthcare: ["insurance verification", "claims", "patient billing", "front desk", "appointment reminders", "prior authorizations", "medical coding", "patient intake", "no-shows", "insurance claims", "claim denials", "referrals", "patient scheduling", "eligibility checks", "EHR", "patient records", "dental billing", "recall reminders", "clinic admin", "medical billing"],
  legal: ["legal paperwork", "client intake", "deadline tracking", "paralegal", "document review", "billable hours", "court filings", "dictation", "conflict checks", "case files", "legal billing", "contract drafting", "discovery documents", "e-filing", "law firm admin", "time entries", "legal research", "client updates", "engagement letters", "matter management"],
  professional_services: ["timesheets", "invoice follow-ups", "proposals", "expense reports", "project admin", "client onboarding", "spreadsheets", "CRM updates", "status reports", "resource planning", "client reporting", "scope changes", "billing cycles", "meeting notes", "RFP responses", "project tracking", "time tracking", "utilization reports", "contract renewals", "onboarding paperwork"],
  retail_ecommerce: ["order processing", "product listings", "inventory", "returns", "catalog updates", "stock levels", "customer emails", "invoices", "order fulfillment", "refunds", "product uploads", "Shopify orders", "marketplace listings", "price updates", "shipping labels", "stock counts", "supplier orders", "customer support tickets", "order tracking", "reconciling payouts"],
  insurance: ["policy renewals", "quotes", "claims", "back office", "client paperwork", "certificates of insurance", "follow-up calls", "data entry", "policy changes", "endorsements", "commission tracking", "carrier portals", "renewal reminders", "claims follow-up", "policy documents", "client onboarding", "quote comparisons", "premium payments", "insurance agency", "underwriting paperwork"],
  lending_finance: ["loan processing", "loan files", "document collection", "underwriting paperwork", "collections", "payment reconciliation", "closing documents", "KYC", "loan applications", "bank statements", "credit checks", "mortgage processing", "borrower documents", "compliance checks", "disbursements", "EMI collections", "income verification", "loan origination", "pipeline reports", "client onboarding"],
  travel: ["bookings", "itinerary changes", "visa paperwork", "reservations", "ticketing", "travel quotes", "supplier invoices", "booking follow-ups", "group bookings", "hotel confirmations", "tour bookings", "refund requests", "passenger lists", "travel itineraries", "booking changes", "vendor payments", "customer enquiries", "travel documents", "cancellations", "package quotes"],
  education: ["admissions", "enquiries", "parent communication", "fee collection", "lead follow-ups", "enrollment paperwork", "timetables", "report cards", "attendance tracking", "student records", "fee reminders", "exam schedules", "admission forms", "student onboarding", "course registrations", "certificates", "school admin", "progress reports", "counselling calls", "application tracking"],
  manufacturing: ["purchase orders", "production planning", "inventory counts", "dispatch planning", "vendor follow-ups", "spreadsheets", "supplier invoices", "quality records", "production schedules", "material planning", "stock reconciliation", "job cards", "work orders", "BOM updates", "shop floor reports", "raw material", "order tracking", "delivery challans", "ERP data entry", "quality reports"],
  wholesale_trading: ["quotations", "order entry", "price lists", "purchase orders", "stock updates", "invoices", "payment follow-ups", "spreadsheets", "customer orders", "supplier orders", "stock reconciliation", "credit notes", "sales orders", "delivery notes", "inventory updates", "order confirmations", "price quotes", "distributor orders", "outstanding payments", "stock reports"],
  construction: ["site paperwork", "estimates", "quantity takeoff", "progress billing", "subcontractor invoices", "document control", "procurement", "spreadsheets", "daily site reports", "change orders", "bid documents", "material orders", "project schedules", "RFIs", "submittals", "site diaries", "payment applications", "BOQ", "timesheets", "punch lists"],
  field_services: ["dispatcher", "scheduling", "service calls", "work orders", "invoicing", "job quotes", "technician scheduling", "parts orders", "job scheduling", "customer callbacks", "service tickets", "maintenance contracts", "job tracking", "estimates", "route planning", "booking jobs", "follow-up calls", "service reports", "ServiceTitan", "job sheets"],
  automotive: ["service advisors", "warranty claims", "repair orders", "parts orders", "estimates", "appointment booking", "dealership paperwork", "deal jackets", "service reminders", "vehicle inspections", "parts inventory", "customer follow-ups", "service scheduling", "DMS", "finance paperwork", "vehicle registrations", "trade-in appraisals", "service bookings", "workshop scheduling", "job cards"],
};

// Measured 2026-11-06: a plain "manually … invoices" query returned 10/10 vendor posts, so every
// query excludes the words vendors and newsletters use. "-hiring" is not excluded: a founder hiring for desk
// work is an implied signal, and the snippet gate drops recruiter wording.
const NO_VENDOR = "-automation -automate -AI -software -platform -solution -demo -webinar -newsletter -edition -podcast";
export const TOPICS_PER_RUN = 4;

// Free-text keyword from Run now: plain words only, so it cannot add search operators.
export const SOCIAL_KEYWORD = /^[\p{L}\p{N}][\p{L}\p{N} &'.-]{0,39}$/u;

// One Google query: a keyword the operator typed, or the vertical's next topics in rotation
// (`runIndex` = earlier social runs for this vertical, so each run moves on to new topics).
export function socialQuery(vertical: VerticalSlug, opts: { keyword?: string | null; runIndex?: number } = {}): { query: string; label: string } {
  const quote = (t: string) => `"${t.replace(/"/g, "")}"`;
  let terms: string[];
  if (opts.keyword?.trim()) terms = [opts.keyword.trim()];
  else {
    const all = SOCIAL_TOPICS[vertical];
    const start = ((opts.runIndex ?? 0) * TOPICS_PER_RUN) % all.length;
    terms = Array.from({ length: Math.min(TOPICS_PER_RUN, all.length) }, (_, i) => all[(start + i) % all.length]!);
  }
  return { query: `site:linkedin.com/posts (${terms.map(quote).join(" OR ")}) ${NO_VENDOR}`, label: terms.join(", ") };
}

// Google search actor (verified 2026-11-06): $0.0045 per results page (~10 results) on the FREE
// plan, $0.00005 per run. Apify rejects a run cap below $0.50 for this actor.
export const SEARCH_PRICES = { "search-page-scraped": 0.0045, "apify-actor-start": 0.00005 };
export const SEARCH_ACTOR = "apify/google-search-scraper";
export const SEARCH_ACTOR_MIN_CAP = 0.5;

export function linkedinSearchInput(x: { query: string; country: string; pages: number }) {
  return { queries: x.query, quickDateRange: "d21", maxPagesPerQuery: x.pages, countryCode: x.country, saveHtmlToKeyValueStore: false };
}

// linkedin.com/posts/<slug>_<words>-activity-<19 digits>-<suffix>. The activity id carries the
// post time (id >> 22 = Unix ms), so freshness is checked without opening the post.
export function linkedinPost(url: string): { id: string; postedAt: Date; slug: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !/(^|\.)linkedin\.com$/.test(u.hostname) || !u.pathname.startsWith("/posts/")) return null;
  const m = u.pathname.match(/^\/posts\/([^/_]+)_[^/]*activity-(\d{19})/);
  if (!m) return null;
  return { id: m[2]!, postedAt: new Date(Number(BigInt(m[2]!) >> 22n)), slug: m[1]! };
}
