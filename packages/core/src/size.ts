// Company size rules (PRD §6.7, Q40, Q57). Never spends money: inputs come from free sources.
import type { SizeSource, SizeTier } from "./contracts.ts";

export interface SizeInput {
  employeeBand?: string | null; // as reported, e.g. "51 to 200", "11-50 employees", "10,000+"
  knownLargeBrand?: boolean;
  bandSource?: Extract<SizeSource, "job_board" | "search_snippet">;
  domainRegisteredAt?: Date | null;
  now: Date;
}

export type SizeResult =
  | { keep: true; tier: SizeTier; source: SizeSource }
  | { keep: false; reason: "too_large" | "too_small"; source: SizeSource };

// Lower bound of a reported band. "201 to 500" → 201, "10,000+" → 10000, "1" → 1.
export function bandLowerBound(band: string): number | null {
  const m = band.replace(/,/g, "").match(/\d+/);
  return m ? Number(m[0]) : null;
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

export function classifySize(input: SizeInput): SizeResult {
  if (input.knownLargeBrand) return { keep: false, reason: "too_large", source: "llm_brand" };

  const lower = input.employeeBand ? bandLowerBound(input.employeeBand) : null;
  if (lower !== null) {
    const source = input.bandSource ?? "job_board";
    // Classified by the band's lower bound, so "501 to 1,000" stays Mid-size.
    if (lower >= 1000) return { keep: false, reason: "too_large", source };
    if (lower < 2) return { keep: false, reason: "too_small", source };
    return { keep: true, tier: lower >= 250 ? "midsize" : "smb", source };
  }

  // Unknown size: domain age only tags young companies, never drops (Q57).
  if (input.domainRegisteredAt) {
    const years = (input.now.getTime() - input.domainRegisteredAt.getTime()) / YEAR_MS;
    if (years < 4) return { keep: true, tier: "startup", source: "domain_age" };
    if (years < 6) return { keep: true, tier: "growth", source: "domain_age" };
  }
  return { keep: true, tier: "unknown", source: "none" };
}
