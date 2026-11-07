// The 16 verticals (PRD §4.1b). `companies.vertical` and `ingestion_runs.vertical` store the slug.
import { z } from "zod";

export const VERTICALS = {
  real_estate: "Real estate & property management",
  logistics: "Logistics, freight & customs brokerage",
  accounting: "Accounting, bookkeeping & tax",
  healthcare: "Healthcare clinics & dental",
  legal: "Legal",
  professional_services: "Professional services",
  retail_ecommerce: "Retail & e-commerce",
  insurance: "Insurance agencies & brokers",
  lending_finance: "Lending & financial advisory",
  travel: "Travel & tour operators",
  education: "Education & training",
  manufacturing: "Manufacturing",
  wholesale_trading: "Wholesale, distribution & trading",
  construction: "Construction, contracting & fit-out",
  field_services: "Home, field & facility services",
  automotive: "Automotive dealers & service centres",
} as const;

export type VerticalSlug = keyof typeof VERTICALS;
export const VerticalSlug = z.enum(Object.keys(VERTICALS) as [VerticalSlug, ...VerticalSlug[]]);

export const COUNTRIES = { in: "India", ae: "UAE", us: "US" } as const;
export type Country = keyof typeof COUNTRIES;

// Markets each vertical runs in (§4.1b): 45 vertical × market slots.
const ALL: Country[] = ["in", "ae", "us"];
export const VERTICAL_MARKETS: Record<VerticalSlug, Country[]> = {
  real_estate: ALL,
  logistics: ALL,
  accounting: ALL,
  healthcare: ALL,
  legal: ALL,
  professional_services: ALL,
  retail_ecommerce: ALL,
  insurance: ALL,
  lending_finance: ALL,
  travel: ALL,
  education: ["in", "ae"],
  manufacturing: ["in", "us"],
  wholesale_trading: ALL,
  construction: ALL,
  field_services: ["ae", "us"],
  automotive: ALL,
};

// 🔴 "Fixer" hires (PRD §1.1): someone brought in to bring order to an owner-run business. They
// are not tied to one vertical, so a fixer run has no vertical and the AI reads it from the post.
export const FIXER_TITLES = [
  "chief of staff",
  "director of operations",
  "head of operations",
  "operations manager",
  "process improvement manager",
  "business operations manager",
] as const;

// Desk-role Indeed search titles per vertical (§4.1 rotation). Starting picks for phrase mining
// (§6.3); the rotation keeps the ones whose posts pass the Bouncer.
export const SEARCH_TITLES: Record<VerticalSlug, string[]> = {
  real_estate: ["property administrator", "leasing coordinator", "real estate admin"],
  logistics: ["logistics coordinator", "documentation executive", "freight forwarding coordinator"],
  accounting: ["accounts assistant", "bookkeeper", "accounts payable clerk"],
  healthcare: ["medical receptionist", "dental front desk", "medical billing"],
  legal: ["legal assistant", "paralegal", "legal secretary"],
  professional_services: ["project coordinator engineering", "proposal coordinator", "office administrator consulting"],
  retail_ecommerce: ["ecommerce executive", "catalog executive", "order processing executive"],
  insurance: ["insurance agency assistant", "insurance back office", "insurance customer service"],
  lending_finance: ["loan processor", "mortgage processor", "credit operations executive"],
  travel: ["travel consultant", "reservations executive", "visa executive"],
  education: ["admissions counselor", "academic coordinator", "school front office"],
  manufacturing: ["purchase executive", "production planning coordinator", "dispatch coordinator"],
  wholesale_trading: ["sales coordinator", "order entry clerk", "inside sales coordinator"],
  construction: ["site administrator", "quantity surveyor assistant", "construction office administrator"],
  field_services: ["service coordinator", "hvac dispatcher", "facility management coordinator"],
  automotive: ["service advisor", "warranty administrator", "dealership administrator"],
};
