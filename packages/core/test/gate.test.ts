import { describe, expect, it } from "vitest";
import { ApifyRunEvent, gateJobPost, matchAtoms } from "../src/index.ts";

describe("gate-job-post (§5.1 step 3)", () => {
  it("passes a desk role with ≥ 2 work atoms", () => {
    const g = gateJobPost({ title: "Accounts Assistant", description: "Data entry of supplier invoices into Tally and monthly bank reconciliation." });
    expect(g.pass).toBe(true);
  });

  it("drops recruiters before anything else", () => {
    const g = gateJobPost({ title: "Data Entry Clerk", description: "We are hiring for a leading client. Data entry, invoices, Excel." });
    expect(g).toMatchObject({ pass: false, reason: "recruiter" });
  });

  it("drops physical roles even with desk words", () => {
    expect(gateJobPost({ title: "Delivery Driver", description: "Update records in Excel and scan delivery documents." })).toMatchObject({ pass: false, reason: "trie" });
  });

  it("drops posts with fewer than 2 work atoms", () => {
    expect(gateJobPost({ title: "Office Manager", description: "Lead a friendly team." })).toMatchObject({ pass: false, reason: "trie" });
  });

  it("fixture A forces founder dependency via INFORMATION_SILO (§6.6)", () => {
    const g = gateJobPost({
      title: "Operations Assistant",
      description: "Organize the company drive, create and maintain SOPs for the sales team, and ensure physical copies are digitized.",
    });
    expect(g).toMatchObject({ pass: true, founderDependency: true });
  });

  it("matches whole words; * marks a stem", () => {
    expect(matchAtoms("sapphire glass")).toEqual([]);
    expect(matchAtoms("SAP and reconciliation").map((m) => m.atom)).toEqual(["reconcil*", "sap"]);
    expect(matchAtoms("a sop and SOPs").filter((m) => m.atom === "sop*")).toHaveLength(1);
  });
});

describe("queue payloads", () => {
  it("Apify ids are alphanumeric only (they go into API paths)", () => {
    expect(ApifyRunEvent.safeParse({ apifyRunId: "HH6wvHiNczKR1M62O" }).success).toBe(true);
    expect(ApifyRunEvent.safeParse({ apifyRunId: "../acts/x/runs" }).success).toBe(false);
  });
});
