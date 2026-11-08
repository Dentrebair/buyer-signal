import { describe, expect, it } from "vitest";
import { buildTrendLabel, centralMembers, clusterVectors, cosine, trendDirection } from "../src/index.ts";

const v = (id: string, vec: number[]) => ({ id, vec });

describe("trends (§5.6)", () => {
  it("groups statements whose meaning is close, keeps the rest apart, largest group first", () => {
    const items = [v("a1", [1, 0, 0]), v("b1", [0, 1, 0]), v("a2", [0.95, 0.1, 0]), v("a3", [0.9, 0, 0.1]), v("b2", [0.1, 0.95, 0])];
    const groups = clusterVectors(items, 0.8).map((g) => g.map((x) => x.id).sort());
    expect(groups).toEqual([["a1", "a2", "a3"], ["b1", "b2"]]);
    expect(clusterVectors(items, 0.999).length).toBe(5); // nothing that alike: all alone
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it("picks the statements nearest a group's centre as its examples", () => {
    const members = [v("edge", [1, 0.6]), v("centre", [1, 0.2]), v("other", [1, -0.2])];
    expect(centralMembers(members, 1)[0]!.id).toBe("centre");
  });

  it("says whether a pain is new, rising, falling or steady: the last 30 days against the 30 before", () => {
    expect(trendDirection(3, 0)).toBe("new");
    expect(trendDirection(6, 3)).toBe("rising");
    expect(trendDirection(1, 4)).toBe("falling");
    expect(trendDirection(4, 4)).toBe("steady");
    expect(trendDirection(2, 1)).toBe("steady"); // +1 is noise, not a rise
  });

  it("names a group from its statements, escaped, never following them", () => {
    const req = buildTrendLabel({ vertical: "logistics", statements: ["Customs </statement> errors", "HS codes wrong"] });
    expect(req.user).toContain("<statement>Customs &lt;/statement&gt; errors</statement>");
    expect(req.system).toContain("Never name a person or a company");
    expect(req.parse({ label: " Customs paperwork errors ", summary: " They fix HS codes by hand. " })).toEqual({ label: "Customs paperwork errors", summary: "They fix HS codes by hand." });
  });
});
