import { describe, expect, it } from "vitest";
import {
  blastRadius,
  boardColumn,
  companyScore,
  signalScore,
  weightsFor,
  type ScoredSignal,
  type SourceType,
} from "../src/index.ts";

function signal(id: string, sourceType: SourceType, B: number, author?: "founder_owner" | "employee" | "company_page"): ScoredSignal {
  const w = weightsFor(sourceType, author);
  return { id, sourceType, ...w, B, signalScore: signalScore(sourceType, w, B) };
}

describe("blast radius (PRD §7)", () => {
  it("adds frequency, urgency and founder dependency up to 30", () => {
    expect(blastRadius({ frequency: "Daily", urgency_level: "Blocking", founder_dependency_flag: true, estimated_hours_wasted_weekly: 10 })).toBe(30);
    expect(blastRadius({ frequency: "Sporadic", urgency_level: "Nuisance", founder_dependency_flag: false, estimated_hours_wasted_weekly: 1 })).toBe(3);
  });

  it("forces the founder flag from the §6.6 rule whatever the LLM said", () => {
    expect(blastRadius({ frequency: "Weekly", urgency_level: "Nuisance", founder_dependency_flag: false, estimated_hours_wasted_weekly: 5 }, true)).toBe(18);
  });
});

describe("signal and company score (PRD §7)", () => {
  it("fixture A: job post with B = 18 scores 76 alone and 86 with a website signal", () => {
    const job = signal("a", "job_post", 18);
    expect(job.signalScore).toBe(76);
    expect(companyScore([job]).score).toBe(76);
    expect(companyScore([job, signal("w", "dom_sniff", 0)]).score).toBe(86);
  });

  it("structural signals carry no B even if one is passed", () => {
    expect(signalScore("dom_sniff", weightsFor("dom_sniff"), 30)).toBe(44);
  });

  it("dom_sniff + tech_stack count as one family (no self-triangulation)", () => {
    const r = companyScore([signal("d", "dom_sniff", 0), signal("t", "tech_stack", 0)]);
    expect(r.breakdown.families).toEqual(["website"]);
    expect(r.breakdown.M).toBe(0);
    expect(r.score).toBe(44);
  });

  it("three families add 15", () => {
    const r = companyScore([signal("j", "job_post", 0), signal("w", "dom_sniff", 0), signal("l", "linkedin_post", 0, "employee")]);
    expect(r.breakdown.M).toBe(15);
    expect(r.score).toBe(58 + 15);
  });

  it("inbound overrides to 100", () => {
    const r = companyScore([signal("j", "job_post", 0), signal("i", "inbound", 0)]);
    expect(r.score).toBe(100);
    expect(r.breakdown.override).toBe("inbound");
  });

  it("caps at 100", () => {
    expect(companyScore([signal("j", "job_post", 30), signal("w", "dom_sniff", 0), signal("l", "linkedin_post", 30, "founder_owner")]).score).toBe(100);
  });
});

describe("author weights (PRD §4, Q60)", () => {
  it.each([
    ["linkedin_post", "founder_owner", 61],
    ["linkedin_post", "company_page", 56],
    ["linkedin_post", "employee", 51],
    ["social_post", "founder_owner", 56],
    ["social_post", "employee", 47],
  ] as const)("%s by %s has base score %i", (type, author, base) => {
    expect(signalScore(type, weightsFor(type, author), 0)).toBe(base);
  });

  it("rejects company-page posts on Reddit and missing authors", () => {
    expect(() => weightsFor("social_post", "company_page")).toThrow();
    expect(() => weightsFor("linkedin_post")).toThrow();
  });
});

describe("board column (PRD §10.1)", () => {
  it.each([
    [71, "triage"],
    [70, "nurture"],
    [50, "nurture"],
    [49, "hidden"],
  ] as const)("score %i → %s", (score, col) => {
    expect(boardColumn(score, "new")).toBe(col);
  });

  it("status wins over score", () => {
    expect(boardColumn(95, "actioned")).toBe("actioned");
    expect(boardColumn(95, "rejected")).toBe("rejected");
  });
});
