// Budget arithmetic (PRD §5.3, Q58). The atomic reservation itself lives in @bs/db.

export interface ApifyRunPlan {
  maxItems: number;
  pricePerItem: number; // USD per charged result/page
  startPrice: number; // USD per run start
}

// Worst case the run can cost — what the gate reserves before starting it.
export function worstCaseApifyCost(plan: ApifyRunPlan): number {
  return round6(plan.maxItems * plan.pricePerItem + plan.startPrice);
}

// Apify itself rejects some actors' caps below a minimum (search actor: $0.50); the real cost
// stays bounded by the plan, so the gate still reserves only the worst case.
export function apifyChargeCap(plan: ApifyRunPlan, actorMinimum = 0): number {
  return Math.max(actorMinimum, round6(worstCaseApifyCost(plan) + 0.01));
}

export function monthKey(d: Date): string {
  return `month:${d.toISOString().slice(0, 7)}`;
}

export function apifyCycleKey(cycleStart: Date): string {
  return `apify:${cycleStart.toISOString().slice(0, 10)}`;
}

export interface ApifySettings {
  boardSlotsPerDay: number;
  boardPostsPerSlot: number;
  searchDailyCap: number;
  linkedinSearchDailyCap: number;
  redditDailyPosts: number;
}

export interface ApifyPrices {
  boardPerPost: number;
  boardPerRun: number;
  boardRunsPerSlot: number;
  searchPerQuery: number;
  redditPerPost: number;
  redditPerRun: number;
}

// The §5.3 budget table, computed from live settings so /radar can show it.
export function projectApifyCycle(s: ApifySettings, p: ApifyPrices, days = 30) {
  const boards = days * s.boardSlotsPerDay * (s.boardPostsPerSlot * p.boardPerPost + p.boardRunsPerSlot * p.boardPerRun);
  const search = days * s.searchDailyCap * p.searchPerQuery;
  const linkedin = days * s.linkedinSearchDailyCap * p.searchPerQuery;
  const reddit = days * (s.redditDailyPosts * p.redditPerPost + p.redditPerRun);
  return {
    boards: round6(boards),
    search: round6(search),
    linkedin: round6(linkedin),
    reddit: round6(reddit),
    total: round6(boards + search + linkedin + reddit),
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
