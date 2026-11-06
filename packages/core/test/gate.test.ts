import { describe, expect, it } from "vitest";
import { ApifyRunEvent, SEED_ATOMS, compileAtoms, gateJobPost, matchAtoms } from "../src/index.ts";

// Mechanics run on a fixed atom list, so a new mined build can't change these tests.
const T = compileAtoms(SEED_ATOMS, {
  AUTOMATABLE_TASK: ["data entry", "invoice*", "reconcil*", "sap", "tally", "excel", "update records", "follow-up"],
  DOCUMENT_FRICTION: ["scan*", "digitiz*", "physical copies"],
  RECRUITER: ["for a leading client", "on behalf of our client"],
  PHYSICAL_ROLE: ["field executive"],
});

describe("gate-job-post (§5.1 step 3)", () => {
  it("passes a desk role with ≥ 2 work atoms", () => {
    const g = gateJobPost({ title: "Accounts Assistant", description: "Data entry of supplier invoices into Tally and monthly bank reconciliation." }, null, T);
    expect(g.pass).toBe(true);
  });

  it("drops recruiters before anything else", () => {
    const g = gateJobPost({ title: "Data Entry Clerk", description: "We are hiring for a leading client. Data entry, invoices, Excel." }, null, T);
    expect(g).toMatchObject({ pass: false, reason: "recruiter" });
  });

  it("drops physical roles even with desk words", () => {
    expect(gateJobPost({ title: "Delivery Driver", description: "Update records in Excel and scan delivery documents." }, null, T)).toMatchObject({ pass: false, reason: "trie" });
    expect(gateJobPost({ title: "Field Executive", description: "Update records in Excel and scan delivery documents." }, null, T)).toMatchObject({ pass: false, reason: "trie" });
  });

  it("drops posts with fewer than 2 distinct work atoms", () => {
    expect(gateJobPost({ title: "Office Manager", description: "Lead a friendly team." }, null, T)).toMatchObject({ pass: false, reason: "trie" });
    expect(gateJobPost({ title: "Clerk", description: "Excel, excel and more Excel." }, null, T)).toMatchObject({ pass: false, reason: "trie" });
  });

  it("fixture A forces founder dependency via INFORMATION_SILO (§6.6)", () => {
    const g = gateJobPost(
      {
        title: "Operations Assistant",
        description: "Organize the company drive, create and maintain SOPs for the sales team, and ensure physical copies are digitized.",
      },
      null,
      T,
    );
    expect(g).toMatchObject({ pass: true, founderDependency: true });
  });

  it("matches whole words; * marks a stem; hyphens and spaces are the same", () => {
    expect(matchAtoms("sapphire glass", null, T)).toEqual([]);
    expect(matchAtoms("SAP and reconciliation", null, T).map((m) => m.atom)).toEqual(["sap", "reconcil*"]);
    expect(matchAtoms("a sop and SOPs", null, T).filter((m) => m.atom === "sop*")).toHaveLength(1);
    expect(matchAtoms("daily follow up calls", null, T).map((m) => m.atom)).toEqual(["follow-up"]);
  });

  it("the longer of two overlapping atoms wins", () => {
    const t = compileAtoms({ AUTOMATABLE_TASK: ["data entry"], MANUAL_ROLE: ["data entry operator"] });
    expect(matchAtoms("Data Entry Operator needed", null, t)).toEqual([{ category: "MANUAL_ROLE", atom: "data entry operator" }]);
  });

  it("the shipped atoms pass fixture A and drop a recruiter post", () => {
    const a = gateJobPost({
      title: "Operations Assistant",
      description: "Your main duties will be to organize the company drive, create and maintain SOPs for the sales team, and ensure physical copies are digitized.",
    });
    expect(a).toMatchObject({ pass: true, founderDependency: true });
    expect(gateJobPost({ title: "Accounts Executive", description: "Hiring on behalf of our client, a trading firm. Invoices, data entry and reconciliation." })).toMatchObject({
      pass: false,
      reason: "recruiter",
    });
  });
});

describe("queue payloads", () => {
  it("Apify ids are alphanumeric only (they go into API paths)", () => {
    expect(ApifyRunEvent.safeParse({ apifyRunId: "HH6wvHiNczKR1M62O" }).success).toBe(true);
    expect(ApifyRunEvent.safeParse({ apifyRunId: "../acts/x/runs" }).success).toBe(false);
  });
});
