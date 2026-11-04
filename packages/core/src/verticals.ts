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
