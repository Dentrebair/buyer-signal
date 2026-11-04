// Freshness rule (PRD §4.3, Q55): only signals published in the last 21 days.
export const MAX_SIGNAL_AGE_DAYS = 21;

const DAY_MS = 24 * 3600 * 1000;

export type FreshnessResult = { fresh: true } | { fresh: false; reason: "too_old" | "undated" };

// `sourceFiltered`: the run used the source's own date filter, so an undated item is trusted.
export function checkFreshness(postedAt: Date | null, now: Date, sourceFiltered: boolean): FreshnessResult {
  if (!postedAt || Number.isNaN(postedAt.getTime())) {
    return sourceFiltered ? { fresh: true } : { fresh: false, reason: "undated" };
  }
  return now.getTime() - postedAt.getTime() > MAX_SIGNAL_AGE_DAYS * DAY_MS
    ? { fresh: false, reason: "too_old" }
    : { fresh: true };
}
