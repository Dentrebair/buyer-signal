import { describe, expect, it } from "vitest";
import { alertEmail, dailyAlerts } from "../src/index.ts";

const quiet = { apify: { spent: 1, cap: 4.5 }, ai: { spent: 2, cap: 20 }, failedRuns: [], deadJobs: [], cards24h: 3, runs24h: 2, rotationEnabled: true, driftWorse: [] };

describe("daily alert (Q65)", () => {
  it("is quiet when nothing needs the operator", () => {
    expect(dailyAlerts(quiet)).toEqual([]);
  });

  it("budget at 80 % or more, failed runs, dead jobs, worse health numbers", () => {
    const a = dailyAlerts({
      ...quiet,
      apify: { spent: 3.6, cap: 4.5 },
      failedRuns: [{ source: "li_posts", n: 2 }],
      deadJobs: [{ queue: "extract-llm", n: 1 }],
      driftWorse: ["Pain posts that became cards"],
    });
    expect(a.map((x) => x.kind)).toEqual(["apify_budget", "failed_runs", "dead_jobs", "drift"]);
    expect(a[0]!.message).toBe("Apify this billing cycle is at 80% of its cap ($3.60 of $4.50). Runs past the cap wait for the next period.");
    expect(a[1]!.message).toContain("2 LinkedIn post search");
  });

  it("no cards in 24 h only matters on a day searches ran or the rotation is on", () => {
    expect(dailyAlerts({ ...quiet, cards24h: 0 }).map((x) => x.kind)).toEqual(["no_cards"]);
    expect(dailyAlerts({ ...quiet, cards24h: 0, runs24h: 0, rotationEnabled: false })).toEqual([]);
  });

  it("one email listing every alert, with the dashboard link", () => {
    const e = alertEmail([{ kind: "no_cards", message: "No new cards." }], "2026-11-09", "http://localhost:3000/health");
    expect(e.subject).toBe("Buying signal: 1 thing needs a look (2026-11-09)");
    expect(e.text).toBe("- No new cards.\n\nHealth dashboard: http://localhost:3000/health");
  });
});
