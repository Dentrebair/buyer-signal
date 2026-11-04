import { describe, expect, it } from "vitest";
import {
  apifyChargeCap,
  bandLowerBound,
  bareDomain,
  checkFreshness,
  classifySize,
  domainCacheKey,
  projectApifyCycle,
  worstCaseApifyCost,
} from "../src/index.ts";

const now = new Date("2026-11-03T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000);
const yearsAgo = (y: number) => new Date(now.getTime() - y * 365.25 * 86400_000);

describe("size (PRD §6.7, Q57)", () => {
  it("reads band lower bounds as Indeed and LinkedIn report them", () => {
    expect(bandLowerBound("51 to 200")).toBe(51);
    expect(bandLowerBound("10,000+")).toBe(10000);
    expect(bandLowerBound("Company size: 2-10 employees")).toBe(2);
  });

  it.each([
    ["2 to 10", { keep: true, tier: "smb" }],
    ["201 to 500", { keep: true, tier: "smb" }],
    ["501 to 1,000", { keep: true, tier: "midsize" }],
    ["1,001 to 5,000", { keep: false, reason: "too_large" }],
    ["1", { keep: false, reason: "too_small" }],
  ] as const)("band %s", (band, expected) => {
    expect(classifySize({ employeeBand: band, now })).toMatchObject(expected);
  });

  it("drops widely known large brands without a band", () => {
    expect(classifySize({ knownLargeBrand: true, now })).toMatchObject({ keep: false, reason: "too_large", source: "llm_brand" });
  });

  it("domain age only tags young companies and never drops", () => {
    expect(classifySize({ domainRegisteredAt: yearsAgo(2), now })).toMatchObject({ keep: true, tier: "startup" });
    expect(classifySize({ domainRegisteredAt: yearsAgo(5), now })).toMatchObject({ keep: true, tier: "growth" });
    expect(classifySize({ domainRegisteredAt: yearsAgo(29), now })).toMatchObject({ keep: true, tier: "unknown" });
    expect(classifySize({ now })).toMatchObject({ keep: true, tier: "unknown", source: "none" });
  });
});

describe("freshness (PRD §4.3)", () => {
  it("keeps 21 days, drops older", () => {
    expect(checkFreshness(daysAgo(21), now, false)).toEqual({ fresh: true });
    expect(checkFreshness(daysAgo(22), now, false)).toEqual({ fresh: false, reason: "too_old" });
  });

  it("drops undated items unless the source filtered by date", () => {
    expect(checkFreshness(null, now, false)).toEqual({ fresh: false, reason: "undated" });
    expect(checkFreshness(null, now, true)).toEqual({ fresh: true });
  });
});

describe("budget (PRD §5.3)", () => {
  it("reserves the run's worst case", () => {
    expect(worstCaseApifyCost({ maxItems: 35, pricePerItem: 0.0001, startPrice: 0.001 })).toBe(0.0045);
  });

  it("respects an actor's minimum charge cap", () => {
    expect(apifyChargeCap({ maxItems: 15, pricePerItem: 0.0045, startPrice: 0.00005 }, 0.5)).toBe(0.5);
  });

  it("default settings project under the $4.50 Apify cap", () => {
    const p = projectApifyCycle(
      { boardSlotsPerDay: 3, boardPostsPerSlot: 35, searchDailyCap: 15, linkedinSearchDailyCap: 3, redditDailyPosts: 10 },
      { boardPerPost: 0.0001, boardPerRun: 0.001, boardRunsPerSlot: 2, searchPerQuery: 0.0045, redditPerPost: 0.0015, redditPerRun: 0.001 },
    );
    expect(p.total).toBeLessThan(4.5);
    expect(p.search).toBeCloseTo(2.025, 3);
  });
});

describe("names", () => {
  it("normalises legal suffixes for the cache key", () => {
    expect(domainCacheKey("Elite East Paradise Sea Cargo Services LLC", "Dubai")).toBe("elite east paradise sea cargo services:dubai");
    expect(domainCacheKey("Innovative Codes (I) Private Limited", null)).toBe("innovative codes:");
  });

  it("extracts bare domains", () => {
    expect(bareDomain("https://www.SmartDocsNow.com/about")).toBe("smartdocsnow.com");
    expect(bareDomain("not a url")).toBeNull();
  });
});
