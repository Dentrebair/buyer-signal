// Drift check (agreed 2026-11-08): the AI and the searches can change without anyone noticing —
// a model update makes the AI more lenient, a topic stops yielding. Each day the last 7 days of
// a few health numbers are compared with the 14 days before; a number that moved more than chance
// explains is flagged on the inbox. Pure: the worker counts, this judges.

export const DRIFT_WINDOW_DAYS = 7;
export const DRIFT_BASE_DAYS = 14;
const MIN_N = 20; // fewer cases than this in either period: too few to judge
const Z_FLAG = 2.58; // a change chance would explain once in 100
const MIN_CARDS = 5; // cost per card needs this many cards in each period
const RATIO_FLAG = 2; // cost per card doubled or halved

export type DriftMetric =
  | "li_pain_rate" // LinkedIn posts read that show pain
  | "li_card_rate" // pain posts that became cards
  | "li_no_market" // pain posts outside our markets
  | "ai_error_rate" // LinkedIn posts the AI could not read or card
  | "reject_rate" // judged cards you rejected as not real pain or the wrong company
  | "check_found_rate" // company checks that found a website
  | "ai_cost_per_card"; // AI spend per new card (USD)

// What the period's numbers are: a share (num of den) or a ratio (num USD per den cards).
export const DRIFT_METRICS: Record<DriftMetric, { label: string; kind: "share" | "ratio"; worseWhen: "up" | "down" }> = {
  li_pain_rate: { label: "LinkedIn posts with pain", kind: "share", worseWhen: "down" },
  li_card_rate: { label: "Pain posts that became cards", kind: "share", worseWhen: "down" },
  li_no_market: { label: "Pain posts outside our markets", kind: "share", worseWhen: "up" },
  ai_error_rate: { label: "Posts the AI could not read", kind: "share", worseWhen: "up" },
  reject_rate: { label: "Judged cards you rejected", kind: "share", worseWhen: "up" },
  check_found_rate: { label: "Company checks that found a website", kind: "share", worseWhen: "down" },
  ai_cost_per_card: { label: "AI cost per card", kind: "ratio", worseWhen: "up" },
};

export interface DriftCounts {
  num: number;
  den: number;
}

export interface DriftResult {
  metric: DriftMetric;
  window: DriftCounts;
  base: DriftCounts;
  windowValue: number | null;
  baseValue: number | null;
  verdict: "ok" | "moved" | "too_few";
  direction: "up" | "down" | null;
  worse: boolean; // moved, in the direction that hurts
}

const value = (c: DriftCounts) => (c.den > 0 ? c.num / c.den : null);

// Two-proportion z test for a share; a doubling or halving for a ratio. "moved" either way is
// worth a look: a jump in cards can be the AI turning lenient as much as a good week.
export function compareDrift(metric: DriftMetric, window: DriftCounts, base: DriftCounts): DriftResult {
  const def = DRIFT_METRICS[metric];
  const w = value(window);
  const b = value(base);
  const out = (verdict: DriftResult["verdict"], direction: DriftResult["direction"] = null): DriftResult => ({
    metric,
    window,
    base,
    windowValue: w,
    baseValue: b,
    verdict,
    direction,
    worse: verdict === "moved" && direction === def.worseWhen,
  });
  if (w === null || b === null) return out("too_few");
  if (def.kind === "ratio") {
    if (window.den < MIN_CARDS || base.den < MIN_CARDS || b === 0) return out("too_few");
    const r = w / b;
    return r >= RATIO_FLAG ? out("moved", "up") : r <= 1 / RATIO_FLAG ? out("moved", "down") : out("ok");
  }
  if (window.den < MIN_N || base.den < MIN_N) return out("too_few");
  const p = (window.num + base.num) / (window.den + base.den);
  const se = Math.sqrt(p * (1 - p) * (1 / window.den + 1 / base.den));
  if (se === 0) return out("ok"); // all 0 % or all 100 % in both periods
  const z = (w - b) / se;
  return Math.abs(z) >= Z_FLAG ? out("moved", z > 0 ? "up" : "down") : out("ok");
}
