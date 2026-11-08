import { describe, expect, it } from "vitest";
import { type CheckStep, type LlmClient, MAX_CHECK_STEPS, runCompanyCheck } from "../src/index.ts";

const Q = { company: "Harbor Lane Realty", city: "Austin", country: "us" as const, vertical: "real_estate" };
const step = (x: Partial<CheckStep>): CheckStep => ({
  notes: "n", action: "finish", query: null, url: null, domain: null, size_band: "unknown", size_evidence_url: null,
  vertical_match: "unsure", place_match: "unsure", summary: "s", ...x,
});

// Plays the given steps in order; a search step's call returns `cited`.
function fakeLlm(steps: CheckStep[], opts: { cited?: string[]; cost?: number; worst?: number } = {}) {
  const asked: { user: string; search: boolean }[] = [];
  const llm: LlmClient = {
    worstCaseUsd: async () => opts.worst ?? 0.004,
    json: async (_t, req) => {
      asked.push({ user: req.user, search: !!req.webSearch });
      return { data: req.parse(steps[asked.length - 1] ?? steps.at(-1)) as any, model: "fake", costUsd: opts.cost ?? 0.003, citations: req.webSearch ? (opts.cited ?? []) : [] };
    },
  };
  return { llm, asked };
}

describe("company-check agent (§5.1a)", () => {
  it("searches, opens the homepage, and accepts a domain whose page names the company", async () => {
    const { llm, asked } = fakeLlm([
      step({ action: "open", url: "https://harborlanerealty.com/about" }),
      step({ action: "finish", domain: "harborlanerealty.com", size_band: "11-50", vertical_match: "yes", place_match: "yes" }),
    ]);
    const pages: string[] = [];
    const out = await runCompanyCheck(Q, {
      llm,
      fetchText: async (url) => (pages.push(url), { url, text: "Harbor Lane Realty, a team of 20 agents in Austin, Texas" }),
    });
    expect(out).toMatchObject({ domain: "harborlanerealty.com", sizeBand: "11-50", steps: 2, stoppedBy: "finish" });
    expect(asked[0]).toMatchObject({ search: true });
    expect(asked[0]!.user.startsWith('Search: "Harbor Lane Realty" Austin United States official website')).toBe(true);
    expect(asked[1]!.user).toContain("Harbor Lane Realty, a team of 20 agents");
    expect(pages).toEqual(["https://harborlanerealty.com/about"]);
  });

  it("rejects a domain no search cited and no page confirmed", async () => {
    const { llm } = fakeLlm([step({ domain: "harborlane.com" })], { cited: ["https://www.zillow.com/x"] });
    expect((await runCompanyCheck(Q, { llm, fetchText: async () => null })).domain).toBeNull();
  });

  it("accepts a cited domain, never a directory", async () => {
    const cited = fakeLlm([step({ domain: "harborlanerealty.com" })], { cited: ["https://www.harborlanerealty.com/"] });
    expect((await runCompanyCheck(Q, { llm: cited.llm, fetchText: async () => null })).domain).toBe("harborlanerealty.com");
    const dir = fakeLlm([step({ domain: "linkedin.com" })], { cited: ["https://www.linkedin.com/company/harbor"] });
    expect((await runCompanyCheck(Q, { llm: dir.llm, fetchText: async () => null })).domain).toBeNull();
  });

  it("never opens LinkedIn or other directories", async () => {
    const { llm, asked } = fakeLlm([step({ action: "open", url: "https://www.linkedin.com/company/harbor" }), step({})]);
    let fetched = 0;
    await runCompanyCheck(Q, { llm, fetchText: async () => (fetched++, null) });
    expect(fetched).toBe(0);
    expect(asked[1]!.user).toContain("never opened");
  });

  it("a page that does not name the company is no evidence for its domain", async () => {
    const { llm } = fakeLlm([step({ action: "open", url: "https://other-site.com/" }), step({ domain: "other-site.com" })]);
    const out = await runCompanyCheck(Q, { llm, fetchText: async (url) => ({ url, text: "Welcome to a different business" }) });
    expect(out.domain).toBeNull();
  });

  it("stops at the step limit and at the cost limit", async () => {
    const searching = step({ action: "search", query: "harbor lane realty austin team" });
    const steps = fakeLlm([searching]);
    expect(await runCompanyCheck(Q, { llm: steps.llm, fetchText: async () => null })).toMatchObject({ steps: MAX_CHECK_STEPS, stoppedBy: "steps" });
    const pricey = fakeLlm([searching], { cost: 0.02, worst: 0.02 });
    expect(await runCompanyCheck(Q, { llm: pricey.llm, fetchText: async () => null })).toMatchObject({ steps: 2, stoppedBy: "cost", costUsd: 0.04 });
  });
});
