import { describe, expect, it } from "vitest";
import { atomText, holdOut, isPositive, recallReport, scrubPersonal } from "../src/index.ts";

describe("keyword mining helpers (§6.3)", () => {
  it("atom text is normalized with outer punctuation trimmed", () => {
    expect(atomText("  “Prepare  Invoices”, ")).toBe("prepare invoices");
    expect(atomText("Follow‑up calls.")).toBe("follow-up calls");
  });

  it("scrubs emails and phone numbers, keeps short numbers", () => {
    expect(scrubPersonal("Send CV to hr@acme.in or call +91 98765 43210. 5 years, 2 shifts")).toBe(
      "Send CV to [email removed] or call [phone removed]. 5 years, 2 shifts",
    );
  });

  it("hold-out picks the same n posts per vertical every time", () => {
    const posts = Array.from({ length: 30 }, (_, i) => ({ id: `job:indeed:${i}`, vertical: (i % 2 ? "legal" : "travel") as "legal" | "travel" }));
    const a = holdOut(posts, 5);
    expect(a.size).toBe(10);
    expect(holdOut([...posts].reverse(), 5)).toEqual(a);
    expect(posts.filter((p) => a.has(p.id) && p.vertical === "legal")).toHaveLength(5);
  });

  it("positive = desk role at the employer with some automatable work", () => {
    expect(isPositive({ desk_role: true, recruiter: false, automatable: "some" })).toBe(true);
    expect(isPositive({ desk_role: true, recruiter: true, automatable: "high" })).toBe(false);
    expect(isPositive({ desk_role: false, recruiter: false, automatable: "high" })).toBe(false);
    expect(isPositive({ desk_role: true, recruiter: false, automatable: "none" })).toBe(false);
  });

  it("recall gate: ≥ 85 % pooled and ≥ 70 % in every vertical", () => {
    const rows = (v: "legal" | "travel", hits: number, misses: number, falsePass = 0) => [
      ...Array.from({ length: hits }, () => ({ vertical: v, positive: true, passed: true })),
      ...Array.from({ length: misses }, () => ({ vertical: v, positive: true, passed: false })),
      ...Array.from({ length: falsePass }, () => ({ vertical: v, positive: false, passed: true })),
    ];
    const ok = recallReport([...rows("legal", 18, 2, 2), ...rows("travel", 17, 3)]);
    expect(ok.gateMet).toBe(true);
    expect(ok.pooled.recall).toBeCloseTo(35 / 40);
    expect(ok.pooled.precision).toBeCloseTo(35 / 37);
    // pooled 90 % but one vertical at 60 %
    expect(recallReport([...rows("legal", 30, 0), ...rows("travel", 6, 4)]).gateMet).toBe(false);
  });
});
