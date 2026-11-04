// Indeed via the valig/indeed-jobs-scraper actor (PRD §4.1, Q58). Input and output fields
// verified on 2026-11-03 against the actor's input schema and 125 real items:
// employer.name 92 %, employer.corporateWebsite 43 %, employer.employeesCount 38 %,
// datePublished 100 %.
import type { RawJobPost } from "@bs/core";

export const INDEED_ACTOR = "valig/indeed-jobs-scraper";

// Price list read from the actor (FREE tier): $0.0001 per item, $0.001 per run start.
export const INDEED_PRICES = { "apify-default-dataset-item": 0.0001, "apify-actor-start": 0.001 };

export type IndeedCountry = RawJobPost["country"];
export type IndeedDatePosted = "1" | "3" | "7" | "14";

export function indeedInput(x: { country: IndeedCountry; title: string; location?: string; limit: number; datePosted?: IndeedDatePosted }) {
  return { country: x.country, title: x.title, location: x.location ?? "", limit: x.limit, datePosted: x.datePosted ?? "14" };
}

interface IndeedItem {
  key?: string;
  url?: string;
  title?: string;
  datePublished?: string | null;
  location?: { city?: string; countryCode?: string } | null;
  employer?: { name?: string | null; corporateWebsite?: string; employeesCount?: string } | null;
  description?: { text?: string } | null;
}

// Personal fields (ceoName, street address, contact details) are never copied (§6.5).
export function mapIndeedItem(raw: unknown, country: IndeedCountry): RawJobPost | null {
  const it = raw as IndeedItem;
  if (!it?.key || !it.url || !it.title) return null;
  const posted = it.datePublished ? new Date(it.datePublished) : null;
  return {
    naturalId: `job:indeed:${it.key}`,
    url: it.url,
    title: it.title,
    company: it.employer?.name?.trim() || null,
    description: it.description?.text ?? "",
    postedAt: posted && !Number.isNaN(posted.getTime()) ? posted : null,
    city: it.location?.city || null,
    country,
    boardWebsite: it.employer?.corporateWebsite || null,
    boardEmployeeBand: it.employer?.employeesCount || null,
  };
}
