// Keyword mining (PRD §6.3): pure helpers for the offline mining scripts. The scripts fetch
// posts, ask the LLM for candidate phrases and labels, and build the gate's atom list from
// phrases that really occur in posts.
import { z } from "zod";
import type { VerticalSlug } from "./verticals.ts";

export const MINED_CATEGORIES = [
  "AUTOMATABLE_TASK",
  "MANUAL_ROLE",
  "INTEGRATION_DEBT",
  "DOCUMENT_FRICTION",
  "INFORMATION_SILO",
  "OWNER_DEPENDENCY",
  "PHYSICAL_ROLE",
  "RECRUITER",
] as const;
export type MinedCategory = (typeof MINED_CATEGORIES)[number];

// What the LLM returns per post, for mining posts and evaluation posts alike.
export const PostLabel = z.object({
  id: z.string(),
  desk_role: z.boolean(),
  recruiter: z.boolean(),
  automatable: z.enum(["none", "some", "high"]),
  reason: z.string(),
  phrases: z.array(
    z.object({
      text: z.string(),
      category: z.enum(MINED_CATEGORIES),
      variants: z.array(z.string()),
    }),
  ),
});
export type PostLabel = z.infer<typeof PostLabel>;

// A post should reach the LLM when it is a desk role at the hiring company with some work an
// AI system could take over. That is what recall is measured against (§6.3 step 4).
export function isPositive(l: Pick<PostLabel, "desk_role" | "recruiter" | "automatable">): boolean {
  return l.desk_role && !l.recruiter && l.automatable !== "none";
}

// Lowercase, straight quotes, one kind of dash, single spaces: what atoms are matched against.
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Atom text as stored: normalized, outer punctuation trimmed.
export function atomText(phrase: string): string {
  return normalize(phrase).replace(/^[^a-z0-9]+|[^a-z0-9*]+$/g, "");
}

// Personal data never kept (§6.5), as for the Sprint 0 posts.
export function scrubPersonal(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email removed]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => {
      // A run can carry on past a sentence end ("43210. 5 years"); the number stops there.
      const [num = m, ...rest] = m.split(/\.\s/);
      return num.replace(/\D/g, "").length >= 10 ? ["[phone removed]", ...rest].join(". ") : m;
    });
}

// Deterministic hold-out: the n posts per vertical with the lowest hash are evaluation posts
// and are never mined (§6.3 step 1).
export function holdOut<T extends { id: string; vertical: VerticalSlug }>(posts: T[], n: number): Set<string> {
  const byVertical = new Map<VerticalSlug, T[]>();
  for (const p of posts) byVertical.set(p.vertical, [...(byVertical.get(p.vertical) ?? []), p]);
  const out = new Set<string>();
  for (const list of byVertical.values())
    for (const p of [...list].sort((a, b) => fnv(a.id) - fnv(b.id)).slice(0, n)) out.add(p.id);
  return out;
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export interface RecallRow {
  vertical: VerticalSlug;
  positive: boolean;
  passed: boolean;
}

export interface RecallReport {
  pooled: { recall: number; precision: number; positives: number; passed: number };
  byVertical: Record<string, { recall: number; positives: number; posts: number }>;
  gateMet: boolean;
}

// Gate: recall ≥ 85 % pooled and ≥ 70 % in every vertical; precision reported only (§6.3 step 4).
export function recallReport(rows: RecallRow[]): RecallReport {
  const pct = (a: number, b: number) => (b === 0 ? 1 : a / b);
  const tp = rows.filter((r) => r.positive && r.passed).length;
  const positives = rows.filter((r) => r.positive).length;
  const passed = rows.filter((r) => r.passed).length;
  const byVertical: RecallReport["byVertical"] = {};
  for (const v of new Set(rows.map((r) => r.vertical))) {
    const vr = rows.filter((r) => r.vertical === v);
    const vp = vr.filter((r) => r.positive);
    byVertical[v] = { recall: pct(vp.filter((r) => r.passed).length, vp.length), positives: vp.length, posts: vr.length };
  }
  const pooled = { recall: pct(tp, positives), precision: pct(tp, passed), positives, passed };
  return { pooled, byVertical, gateMet: pooled.recall >= 0.85 && Object.values(byVertical).every((v) => v.recall >= 0.7) };
}
