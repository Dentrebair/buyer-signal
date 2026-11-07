import { describe, expect, it } from "vitest";
import { matchAtoms, urgencyTier } from "../src/index.ts";

const job = (title: string, description: string) => {
  const text = `${title}\n\n${description}`;
  return urgencyTier({ sourceType: "job_post", title, text, matches: matchAtoms(text) });
};
const post = (text: string, authorRelation = "founder_owner") => urgencyTier({ sourceType: "linkedin_post", authorRelation, text, matches: matchAtoms(text) });

describe("urgency tier (§1.1): fixed rules, not the AI's opinion", () => {
  it("high: fixer hires and founder vents", () => {
    expect(job("Chief of Staff", "Support the founder across the business.")).toBe("high");
    expect(job("Operations Lead", "You will bring order to chaos in a fast-growing firm.")).toBe("high");
    expect(post("Another 14-hour day. I can't delegate because everything goes through me.")).toBe("high");
    expect(post("Our team has to rely on the owner for every decision.")).toBe("high");
  });

  it("medium: information silos, data bridged between systems, owner dependency outside the founder's own post", () => {
    expect(job("Office Administrator", "Create and maintain SOPs and organize company drive.")).toBe("medium");
    expect(job("Ops Assistant", "Cross-reference orders between email, Slack and spreadsheets every day.")).toBe("medium");
    expect(post("Our team has to rely on the owner for every decision.", "employee")).toBe("medium");
  });

  it("low: plain data entry, a tool's name, following SOPs, website signals", () => {
    expect(job("Data Entry Clerk", "Enter invoices into QuickBooks and MS Excel daily.")).toBe("low");
    expect(job("Data Entry Operator", "Follow standard operating procedures for each batch.")).toBe("low");
    expect(urgencyTier({ sourceType: "dom_sniff", text: "static pdf form", matches: [] })).toBe("low");
    // A founder post with no bottleneck wording is not a vent.
    expect(post("We still key every invoice by hand at Acme.")).toBe("low");
  });
});
