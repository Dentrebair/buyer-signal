import { describe, expect, it } from "vitest";
import { SOCIAL_KEYWORD, compileAtoms, gateSnippet, weightsFor } from "../src/index.ts";

describe("LinkedIn posts: topics, scoring and the snippet gate (§4.1a, §4.1d)", () => {
  it("keyword: plain words only, so it cannot add search operators", () => {
    expect(SOCIAL_KEYWORD.test("bills of lading")).toBe(true);
    expect(SOCIAL_KEYWORD.test('x" OR site:evil.com')).toBe(false);
    expect(SOCIAL_KEYWORD.test("-automation")).toBe(false);
  });

  it("implied posts keep evidence weight but score lower buying intent", () => {
    expect(weightsFor("linkedin_post", "founder_owner", "suffering")).toEqual({ E: 85, I: 90 });
    expect(weightsFor("linkedin_post", "founder_owner", "implied")).toEqual({ E: 85, I: 75 });
  });

  it("snippet gate: one work atom is enough, recruiters drop", () => {
    const t = compileAtoms({ AUTOMATABLE_TASK: ["data entry"], RECRUITER: ["our client is seeking"] });
    expect(gateSnippet("We still do all our data entry by hand", null, t).pass).toBe(true);
    expect(gateSnippet("Lovely weekend with the team", null, t)).toMatchObject({ pass: false, reason: "trie" });
    expect(gateSnippet("Our client is seeking help with data entry", null, t)).toMatchObject({ pass: false, reason: "recruiter" });
  });
});
