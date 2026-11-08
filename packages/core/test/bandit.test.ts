import { describe, expect, it } from "vitest";
import {
  type Arm,
  type ArmRun,
  FIXER_TITLES,
  SEARCH_TITLES,
  SOCIAL_TOPICS,
  VERTICAL_MARKETS,
  COUNTRIES,
  LOW_CARD_VALUE,
  armStats,
  planDay,
  priorMean,
  sampleGamma,
  seedArms,
  seededRng,
  shouldRetire,
} from "../src/index.ts";

const NOW = new Date("2026-11-07T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const arm = (id: string, x: Partial<Arm> = {}): Arm => ({ id, kind: "job", vertical: "logistics", country: "us", term: id, group: "low", retired: false, revivedAt: null, ...x });
const run = (armId: string, cards: number, x: Partial<ArmRun> = {}): ArmRun => ({ armId, at: daysAgo(1), cost: 0.004, cards, junk: 0, ...x });

describe("search bandit (§4.1c)", () => {
  it("seeds every search the code knows: desk titles Low, fixer titles High in every market, social topics Medium once per vertical", () => {
    const specs = seedArms({ markets: VERTICAL_MARKETS, titles: SEARCH_TITLES, fixerTitles: FIXER_TITLES, countries: Object.keys(COUNTRIES), topics: SOCIAL_TOPICS, topicCountry: "all" });
    const count = (k: string, g: string) => specs.filter((s) => s.kind === k && s.group === g).length;
    expect(count("job", "low")).toBe(45 * 3);
    expect(count("job", "high")).toBe(FIXER_TITLES.length * 3);
    // LinkedIn search has no market filter (§4.1d): one arm per vertical × topic.
    expect(count("social", "medium")).toBe(Object.keys(SOCIAL_TOPICS).length * 20);
    expect(specs.filter((s) => s.kind === "social").every((s) => s.country === "all")).toBe(true);
    expect(specs.filter((s) => s.group === "high").every((s) => s.vertical === null)).toBe(true);
  });

  it("score: cards per dollar minus junk, older runs fade, a revive starts the count again", () => {
    const a = arm("a");
    const fresh = armStats(a, [run("a", 4)], 300, NOW);
    const junky = armStats(a, [run("a", 4, { junk: 3 })], 300, NOW);
    expect(junky.mean).toBeLessThan(fresh.mean);
    const old = armStats(a, [run("a", 4, { at: daysAgo(60) })], 300, NOW);
    expect(old.mean).toBeLessThan(fresh.mean); // 60 days = two half-lives
    const revived = armStats({ ...a, revivedAt: daysAgo(0.5) }, [run("a", 0), run("a", 0)], 300, NOW);
    expect(revived.runs).toBe(0);
  });

  it("retires after 5 runs with no card, not before", () => {
    const a = arm("a");
    expect(shouldRetire(armStats(a, Array.from({ length: 4 }, () => run("a", 0)), 300, NOW))).toBe(false);
    expect(shouldRetire(armStats(a, Array.from({ length: 5 }, () => run("a", 0)), 300, NOW))).toBe(true);
    expect(shouldRetire(armStats(a, [...Array.from({ length: 5 }, () => run("a", 0)), run("a", 1)], 300, NOW))).toBe(false);
  });

  it("prefers the search that pays, but still tries others", () => {
    const arms = [arm("good"), arm("bad")];
    const runs = [...Array.from({ length: 6 }, () => run("good", 3)), ...Array.from({ length: 6 }, () => run("bad", 0))];
    let good = 0;
    for (let i = 0; i < 200; i++) if (planDay(arms, runs, { job: 1, social: 0, topicsPerSocial: 4 }, seededRng(`d${i}`), NOW).job[0]!.id === "good") good++;
    expect(good).toBeGreaterThan(170);
    expect(good).toBeLessThan(200 + 1);
  });

  it("an untried search gets picked now and then (exploration)", () => {
    const arms = [arm("proven"), arm("new")];
    const runs = Array.from({ length: 10 }, () => run("proven", 3));
    let fresh = 0;
    for (let i = 0; i < 200; i++) if (planDay(arms, runs, { job: 1, social: 0, topicsPerSocial: 4 }, seededRng(`e${i}`), NOW).job[0]!.id === "new") fresh++;
    expect(fresh).toBeGreaterThan(20);
  });

  it("three quarters of the day's runs go to High/Medium searches; social runs count, and stay in one vertical × market", () => {
    const arms = [
      ...["d1", "d2", "d3", "d4"].map((id) => arm(id)),
      arm("fixer", { vertical: null, group: "high" }),
      arm("fixer2", { vertical: null, group: "high" }),
      ...["t1", "t2", "t3", "t4", "t5"].map((id) => arm(id, { kind: "social", group: "medium" })),
      arm("t-other", { kind: "social", group: "medium", country: "in" }),
    ];
    const runs = ["d1", "d2", "d3", "d4"].flatMap((id) => Array.from({ length: 5 }, () => run(id, 5))); // desk arms look great
    for (let i = 0; i < 50; i++) {
      const plan = planDay(arms, runs, { job: 3, social: 1, topicsPerSocial: 4 }, seededRng(`f${i}`), NOW);
      expect(plan.job.filter((a) => a.group !== "low").length).toBeGreaterThanOrEqual(2); // 3 of 4 runs, social is 1
      expect(plan.social).toHaveLength(1);
      expect(new Set(plan.social[0]!.topics.map((t) => t.country))).toEqual(new Set([plan.social[0]!.country]));
      // Up to 4 topics; fewer only when the market has fewer live topics (t-other is alone in "in").
      expect(plan.social[0]!.topics).toHaveLength(plan.social[0]!.country === "us" ? 4 : 1);
    }
  });

  it("a Low card counts for a quarter of a High/Medium card", () => {
    const arms = [arm("low-cards"), arm("high-cards")];
    const runs = [
      ...Array.from({ length: 4 }, () => run("low-cards", 2, { value: 2 * LOW_CARD_VALUE })),
      ...Array.from({ length: 4 }, () => run("high-cards", 1)),
    ];
    const prior = priorMean("job", arms, runs, NOW);
    expect(armStats(arms[1]!, runs, prior, NOW).mean).toBeGreaterThan(armStats(arms[0]!, runs, prior, NOW).mean);
  });

  it("skips retired searches", () => {
    const plan = planDay([arm("dead", { retired: true }), arm("live")], [], { job: 2, social: 0, topicsPerSocial: 4 }, seededRng("x"), NOW);
    expect(plan.job.map((a) => a.id)).toEqual(["live"]);
  });

  it("gamma samples average shape / rate", () => {
    const rng = seededRng("g");
    let sum = 0;
    for (let i = 0; i < 4000; i++) sum += sampleGamma(3, 2, rng);
    expect(sum / 4000).toBeCloseTo(1.5, 1);
  });
});
