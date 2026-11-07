// Display labels shared by server and client components.
import type { SizeTier, SourceFamily, SourceType } from "@bs/core";
// Values from the small entry only: this file reaches the browser, and the main entry pulls in
// the HTML parser used by the website sniff.
import { COUNTRIES, VERTICALS } from "@bs/core/verticals";

export const REJECT_REASONS = ["wrong_company", "not_real_pain", "too_small", "already_client", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface Prior {
  status: "new" | "actioned" | "rejected";
  rejection_reason: RejectReason | null;
}

export const REJECT_LABEL: Record<RejectReason, string> = {
  wrong_company: "Wrong company",
  not_real_pain: "Not a real pain",
  too_small: "Too small",
  already_client: "Already a client",
  other: "Other",
};

export const QUEUE_LABEL = { triage: "Triage", nurture: "Nurture", sent: "Sent", rejected: "Rejected" } as const;

// §10.1 size tags.
export const SIZE_LABEL: Record<SizeTier, string> = {
  smb: "SMB",
  midsize: "Mid-size",
  startup: "Startup",
  growth: "Growth",
  unknown: "Size unknown",
};

export const SOURCE_LABEL: Record<SourceType, string> = {
  job_post: "Job post",
  // LinkedIn and Reddit posts show under one label; the platform appears only as the post's
  // corner icon (PostLink).
  linkedin_post: "Social digest",
  social_post: "Social digest",
  dom_sniff: "Website check",
  tech_stack: "Tech stack",
  inbound: "Inbound (/roast)",
};

export const FAMILY_LABEL: Record<SourceFamily, string> = {
  job_post: "Job post",
  linkedin_post: "Social digest",
  social_post: "Social digest",
  website: "Website",
  inbound: "Inbound",
};

export { FULL_AUTOMATION_PCT, SCOPES, SCOPE_LABEL, type Scope, scopeOf } from "@bs/core/scope";
export { PRODUCT_LABEL, PRODUCT_LAYERS, URGENCY_LABEL, URGENCY_TIERS, type UrgencyTier } from "@bs/core/tier";

export const verticalLabel = (slug: string | null) =>
  slug && slug in VERTICALS ? VERTICALS[slug as keyof typeof VERTICALS] : "Vertical unknown";

export const countryLabel = (c: string | null) => (c && c in COUNTRIES ? COUNTRIES[c as keyof typeof COUNTRIES] : "—");

export function ageLabel(d: Date | string | null): string {
  if (!d) return "date not recorded";
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

export const SIZE_ORDER: SizeTier[] = ["smb", "midsize", "startup", "growth", "unknown"];

// Short forms for dense list rows.
export const VERTICAL_SHORT: Record<string, string> = {
  real_estate: "Real estate",
  logistics: "Logistics",
  accounting: "Accounting",
  healthcare: "Healthcare",
  legal: "Legal",
  professional_services: "Prof. services",
  retail_ecommerce: "Retail",
  insurance: "Insurance",
  lending_finance: "Lending",
  travel: "Travel",
  education: "Education",
  manufacturing: "Manufacturing",
  wholesale_trading: "Trading",
  construction: "Construction",
  field_services: "Field services",
  automotive: "Automotive",
};
