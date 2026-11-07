// Shared contracts between worker and UI (PRD §9, §11). Ported from v2.1 §9 minus
// `outreach_draft`, plus the v3 extraction fields (Q56, Q59).
import { z } from "zod";
import { PRODUCT_LAYERS } from "./tier.ts";

export const Department = z.enum([
  "Operations",
  "Finance",
  "Sales & Marketing",
  "HR & Admin",
  "Logistics & Supply Chain",
  "Customer Support",
  "Unknown",
]);
export type Department = z.infer<typeof Department>;

export const Frequency = z.enum(["Daily", "Weekly", "Sporadic"]);
export const Urgency = z.enum(["Blocking", "Nuisance"]);

export const SourceType = z.enum([
  "job_post",
  "linkedin_post",
  "social_post",
  "dom_sniff",
  "tech_stack",
  "inbound",
]);
export type SourceType = z.infer<typeof SourceType>;

export const SourceFamily = z.enum(["job_post", "linkedin_post", "social_post", "website", "inbound"]);
export type SourceFamily = z.infer<typeof SourceFamily>;

// What the LLM may return for LinkedIn/Reddit authors (§4.1a). Only the first three are kept.
export const AuthorRelationOut = z.enum([
  "founder_owner",
  "employee",
  "company_page",
  "former_employee",
  "vendor",
  "commentator",
  "recruiter",
]);
export const AuthorRelation = z.enum(["founder_owner", "employee", "company_page"]);
export type AuthorRelation = z.infer<typeof AuthorRelation>;

// implied (2026-11-06): an upbeat or neutral post — hiring, growth, a thank-you — that shows
// manual, repetitive or headcount-driven work at the author's own business.
export const Stance = z.enum(["suffering", "implied", "selling", "commenting"]);
export const AutomationFit = z.enum(["none", "some", "high"]);
// Which product to pitch first (PRD §1.1): null on cards extracted before 2026-11-07.
export const ProductLayer = z.enum(PRODUCT_LAYERS);
export type ProductLayer = z.infer<typeof ProductLayer>;

export const BlastRadiusHypothesis = z.object({
  frequency: Frequency,
  urgency_level: Urgency,
  founder_dependency_flag: z.boolean(),
  estimated_hours_wasted_weekly: z.number().int().min(1).max(160),
});
export type BlastRadiusHypothesis = z.infer<typeof BlastRadiusHypothesis>;

export const StructuredIntelligence = z.object({
  department: Department,
  verified_symptom: z.string().max(250),
  inferred_tech_stack: z.array(z.string()).default([]),
  automatable_task_percentage: z.number().int().min(0).max(100).nullable(),
  proposed_ai_replacement: z.string().max(200).nullable(),
  blast_radius: BlastRadiusHypothesis,
  automation_fit: AutomationFit,
  product_layer: ProductLayer.nullable().default(null),
  known_large_brand: z.boolean(),
  author_relation: AuthorRelationOut.nullable(), // LinkedIn/Reddit only
  stance: Stance.nullable(), // LinkedIn/Reddit only
});
export type StructuredIntelligence = z.infer<typeof StructuredIntelligence>;

export const ScoreBreakdown = z.object({
  best_signal_id: z.string().nullable(),
  E: z.number(),
  I: z.number(),
  B: z.number(),
  families: z.array(SourceFamily),
  M: z.number(),
  override: z.enum(["inbound"]).nullable(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

export const CompanyStatus = z.enum(["new", "actioned", "rejected"]);
export type CompanyStatus = z.infer<typeof CompanyStatus>;

export const SizeTier = z.enum(["smb", "midsize", "startup", "growth", "unknown"]);
export type SizeTier = z.infer<typeof SizeTier>;

export const SizeSource = z.enum(["job_board", "search_snippet", "llm_brand", "domain_age", "none"]);
export type SizeSource = z.infer<typeof SizeSource>;
