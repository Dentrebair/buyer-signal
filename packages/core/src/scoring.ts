// Scoring (PRD §4, §7). Pure functions; the worker recomputes in the same transaction as
// every challenge insert.
import type {
  AuthorRelation,
  BlastRadiusHypothesis,
  CompanyStatus,
  ScoreBreakdown,
  SourceFamily,
  SourceType,
} from "./contracts.ts";

export interface Weights {
  E: number;
  I: number;
}

const FIXED: Record<Exclude<SourceType, "linkedin_post" | "social_post">, Weights> = {
  job_post: { E: 90, I: 75 },
  dom_sniff: { E: 95, I: 30 },
  tech_stack: { E: 80, I: 35 },
  inbound: { E: 100, I: 100 },
};

// Company posts by author relation (§4, Q60). Reddit has no company pages.
const LINKEDIN: Record<AuthorRelation, Weights> = {
  founder_owner: { E: 85, I: 90 },
  company_page: { E: 80, I: 80 },
  employee: { E: 80, I: 65 },
};
const REDDIT: Partial<Record<AuthorRelation, Weights>> = {
  founder_owner: { E: 75, I: 85 },
  employee: { E: 75, I: 60 },
};

export function sourceFamily(type: SourceType): SourceFamily {
  return type === "dom_sniff" || type === "tech_stack" ? "website" : type;
}

export function weightsFor(type: SourceType, author?: AuthorRelation | null): Weights {
  if (type === "linkedin_post" || type === "social_post") {
    if (!author) throw new Error(`${type} needs an author_relation`);
    const w = (type === "linkedin_post" ? LINKEDIN : REDDIT)[author];
    if (!w) throw new Error(`${type} does not accept author_relation=${author}`);
    return w;
  }
  return FIXED[type];
}

// B (0–30) from the LLM hypothesis (§7). `forceFounder` is the §6.6 deterministic rule.
export function blastRadius(h: BlastRadiusHypothesis, forceFounder = false): number {
  const freq = { Daily: 10, Weekly: 5, Sporadic: 0 }[h.frequency];
  const urg = { Blocking: 10, Nuisance: 3 }[h.urgency_level];
  const founder = h.founder_dependency_flag || forceFounder ? 10 : 0;
  return freq + urg + founder;
}

export function signalScore(type: SourceType, w: Weights, B: number): number {
  const b = sourceFamily(type) === "website" ? 0 : B; // §7: structural signals carry no B
  return Math.min(100, Math.round(0.35 * w.E + 0.35 * w.I + b));
}

export interface ScoredSignal {
  id: string;
  sourceType: SourceType;
  E: number;
  I: number;
  B: number;
  signalScore: number;
}

export function triangulationBonus(familyCount: number): number {
  if (familyCount >= 3) return 15;
  if (familyCount === 2) return 10;
  return 0;
}

export function companyScore(signals: ScoredSignal[]): { score: number; breakdown: ScoreBreakdown } {
  const families = [...new Set(signals.map((s) => sourceFamily(s.sourceType)))];
  if (families.includes("inbound")) {
    const inbound = signals.find((s) => s.sourceType === "inbound") ?? null;
    return {
      score: 100,
      breakdown: {
        best_signal_id: inbound?.id ?? null,
        E: 100,
        I: 100,
        B: 0,
        families,
        M: triangulationBonus(families.length),
        override: "inbound",
      },
    };
  }
  const best = signals.reduce<ScoredSignal | null>(
    (a, s) => (a === null || s.signalScore > a.signalScore ? s : a),
    null,
  );
  const M = triangulationBonus(families.length);
  return {
    score: best ? Math.min(100, best.signalScore + M) : 0,
    breakdown: {
      best_signal_id: best?.id ?? null,
      E: best?.E ?? 0,
      I: best?.I ?? 0,
      B: best?.B ?? 0,
      families,
      M,
      override: null,
    },
  };
}

export type BoardColumn = "triage" | "nurture" | "hidden" | "actioned" | "rejected";

// §10.1: Triage > 70, Nurture 50–70, hidden < 50.
export function boardColumn(score: number, status: CompanyStatus): BoardColumn {
  if (status === "actioned") return "actioned";
  if (status === "rejected") return "rejected";
  if (score > 70) return "triage";
  if (score >= 50) return "nurture";
  return "hidden";
}
