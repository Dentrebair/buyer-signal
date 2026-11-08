// Search bandit (PRD §4.1c): which searches the daily rotation runs. Pure functions; the worker
// and the Sources page share them. Browser-safe (no dependencies).
//
// An arm is one search: job posts = vertical × market × title (vertical null for fixer hires);
// social = vertical × market × topic. Its reward is cards per dollar, minus cards the operator
// rejected as not real pain or the wrong company, with older runs fading (30-day half-life).
// Thompson sampling: each arm's rate has a Gamma posterior (cards ~ Poisson(rate × cost)); each
// day draws one sample per arm and runs the highest. A barely-tried arm has a wide posterior, so
// it is sometimes drawn high and gets tried: that is the exploration.

export type ArmKind = "job" | "social";
export type ArmGroup = "high" | "medium" | "low"; // §1.1 urgency the arm searches for
export type ArmStatus = "trying" | "strong" | "weak" | "retired";

export interface Arm {
  id: string;
  kind: ArmKind;
  vertical: string | null;
  country: string;
  term: string;
  group: ArmGroup;
  retired: boolean;
  revivedAt: Date | null;
}

// One run's result, already credited to one arm (a social run splits across its topics).
export interface ArmRun {
  armId: string;
  at: Date;
  cost: number; // USD
  cards: number; // cards credited to this arm from the run
  junk: number; // of those, rejected as not_real_pain or wrong_company
  value?: number; // the good cards weighted by tier (a Low card = LOW_CARD_VALUE); default cards − junk
}

export interface ArmStats {
  runs: number; // runs since the arm was last revived
  cards: number;
  junk: number;
  cost: number;
  alpha: number; // Gamma posterior shape
  beta: number; // Gamma posterior rate (per USD)
  mean: number; // posterior mean, cards per USD
}

export const HALF_LIFE_DAYS = 30;
export const RETIRE_AFTER_RUNS = 5;
export const EXPLORE_SHARE = 0.2;
export const HIGH_MEDIUM_FLOOR = 0.75;
// A Low card is worth a quarter of a High/Medium one (§4.1c step 2a): Low comes mostly from
// desk-title searches the tier rules always rate Low, so the budget moves away from them.
export const LOW_CARD_VALUE = 0.25;
const PRIOR_SHAPE = 1; // weak: one card's worth of belief
const DEFAULT_PRIOR_MEAN: Record<ArmKind, number> = { job: 300, social: 50 }; // cards per USD, before any data
const DAY = 86_400_000;

const weight = (at: Date, now: Date) => 0.5 ** ((now.getTime() - at.getTime()) / DAY / HALF_LIFE_DAYS);
const credit = (r: ArmRun) => r.value ?? Math.max(0, r.cards - r.junk);

// The prior mean per kind is the pooled rate of that kind so far, so a new arm starts at "average".
export function priorMean(kind: ArmKind, arms: Arm[], runs: ArmRun[], now: Date): number {
  const ids = new Set(arms.filter((a) => a.kind === kind).map((a) => a.id));
  let good = 0;
  let cost = 0;
  for (const r of runs)
    if (ids.has(r.armId)) {
      const w = weight(r.at, now);
      good += w * credit(r);
      cost += w * r.cost;
    }
  return cost > 0 && good > 0 ? good / cost : DEFAULT_PRIOR_MEAN[kind];
}

export function armStats(arm: Arm, runs: ArmRun[], prior: number, now: Date): ArmStats {
  const mine = runs.filter((r) => r.armId === arm.id && (!arm.revivedAt || r.at >= arm.revivedAt));
  let alpha = PRIOR_SHAPE;
  let beta = PRIOR_SHAPE / prior;
  let cards = 0;
  let junk = 0;
  let cost = 0;
  for (const r of mine) {
    const w = weight(r.at, now);
    alpha += w * credit(r);
    beta += w * r.cost;
    cards += r.cards;
    junk += r.junk;
    cost += r.cost;
  }
  return { runs: mine.length, cards, junk, cost, alpha, beta, mean: alpha / beta };
}

export const shouldRetire = (s: ArmStats) => s.runs >= RETIRE_AFTER_RUNS && s.cards === 0;

// For the Searches table: Trying under 2 runs; Strong needs real cards and a rate at or above the
// median of tried arms; everything else that has run is Weak.
export function armStatus(arm: Arm, s: ArmStats, medianMean: number): ArmStatus {
  if (arm.retired) return "retired";
  if (s.runs < 2) return "trying";
  return s.cards - s.junk > 0 && s.mean >= medianMean ? "strong" : "weak";
}

// ── Sampling ────────────────────────────────────────────────────────────────
export type Rng = () => number;

// Seeded so a day's plan can be reproduced (mulberry32).
export function seededRng(seed: string): Rng {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// Marsaglia–Tsang; shape < 1 boosted by u^(1/shape).
export function sampleGamma(shape: number, rate: number, rng: Rng): number {
  if (shape < 1) return sampleGamma(shape + 1, rate, rng) * Math.max(rng(), 1e-12) ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = rng();
    if (Math.log(Math.max(u, 1e-12)) < 0.5 * x * x + d - d * v + d * Math.log(v)) return (d * v) / rate;
  }
}

// ── Seed arms ───────────────────────────────────────────────────────────────
export interface ArmSpec {
  kind: ArmKind;
  vertical: string | null;
  country: string;
  term: string;
  group: ArmGroup;
}

// Every search the code knows today: desk titles (Low), fixer titles in every market (High), and
// social topics (Medium: where founders post), once per vertical: LinkedIn search has no market
// filter, so a topic arm's market is "all" (§4.1d). Arms added later (manual runs, learned, AI)
// join these in the table.
export function seedArms(x: {
  markets: Record<string, readonly string[]>;
  titles: Record<string, readonly string[]>;
  fixerTitles: readonly string[];
  countries: readonly string[];
  topics: Record<string, readonly string[]>;
  topicCountry: string;
}): ArmSpec[] {
  const out: ArmSpec[] = [];
  for (const [vertical, markets] of Object.entries(x.markets)) {
    for (const country of markets) for (const term of x.titles[vertical] ?? []) out.push({ kind: "job", vertical, country, term, group: "low" });
    for (const term of x.topics[vertical] ?? []) out.push({ kind: "social", vertical, country: x.topicCountry, term, group: "medium" });
  }
  for (const country of x.countries) for (const term of x.fixerTitles) out.push({ kind: "job", vertical: null, country, term, group: "high" });
  return out;
}

// ── The day's plan ──────────────────────────────────────────────────────────
export interface DayPlan {
  job: Arm[];
  social: { vertical: string; country: string; topics: Arm[] }[];
}

// n picks from `pool`: each pick is, with EXPLORE_SHARE odds, a random untried arm; otherwise the
// highest posterior draw. Picked arms leave the pool.
function pick(pool: Arm[], stats: Map<string, ArmStats>, n: number, rng: Rng): Arm[] {
  const left = [...pool];
  const out: Arm[] = [];
  while (out.length < n && left.length) {
    const untried = left.filter((a) => (stats.get(a.id)?.runs ?? 0) === 0);
    let chosen: Arm;
    if (untried.length && rng() < EXPLORE_SHARE) chosen = untried[Math.floor(rng() * untried.length)]!;
    else {
      let best = -1;
      chosen = left[0]!;
      for (const a of left) {
        const s = stats.get(a.id)!;
        const draw = sampleGamma(s.alpha, s.beta, rng);
        if (draw > best) {
          best = draw;
          chosen = a;
        }
      }
    }
    out.push(chosen);
    left.splice(left.indexOf(chosen), 1);
  }
  return out;
}

export function planDay(
  arms: Arm[],
  runs: ArmRun[],
  slots: { job: number; social: number; topicsPerSocial: number },
  rng: Rng,
  now: Date,
): DayPlan {
  const active = arms.filter((a) => !a.retired);
  const stats = new Map<string, ArmStats>();
  for (const kind of ["job", "social"] as const) {
    const prior = priorMean(kind, arms, runs, now);
    for (const a of active.filter((x) => x.kind === kind)) stats.set(a.id, armStats(a, runs, prior, now));
  }

  // Social: pick the best topic arms, then fill each run with more topics from its vertical × market.
  const socialPool = active.filter((a) => a.kind === "social");
  const social: DayPlan["social"] = [];
  for (const lead of pick(socialPool, stats, slots.social, rng)) {
    const peers = socialPool.filter((a) => a !== lead && a.vertical === lead.vertical && a.country === lead.country);
    social.push({ vertical: lead.vertical!, country: lead.country, topics: [lead, ...pick(peers, stats, slots.topicsPerSocial - 1, rng)] });
  }

  // Jobs: ≥ HIGH_MEDIUM_FLOOR of the day's runs on High/Medium arms; social runs count towards it.
  const total = slots.job + slots.social;
  const highOwed = Math.max(0, Math.ceil(HIGH_MEDIUM_FLOOR * total) - social.length);
  const jobPool = active.filter((a) => a.kind === "job");
  const high = pick(jobPool.filter((a) => a.group !== "low"), stats, Math.min(highOwed, slots.job), rng);
  const rest = pick(jobPool.filter((a) => !high.includes(a)), stats, slots.job - high.length, rng);
  return { job: [...high, ...rest], social };
}
