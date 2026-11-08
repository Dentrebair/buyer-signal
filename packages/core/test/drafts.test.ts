import { describe, expect, it } from "vitest";
import { type DraftCompany, type DraftEvidence, buildDraft, mergeDraft, recommendStrategy } from "../src/index.ts";

const ev = (x: Partial<DraftEvidence>): DraftEvidence => ({ kind: "job_post", title: "AP Clerk", symptom: "Keys 300 invoices a week", quote: "Enter invoices into Tally", confidence: 95, hours: 20, replacement: "Invoice capture", ...x });
const company = (x: Partial<DraftCompany> = {}): DraftCompany => ({
  name: "Acme Freight", website: "acme-freight.example", vertical: "logistics", country: "us", founderName: null, productLayer: "company_os",
  techStack: ["QuickBooks"], websiteIssues: [], evidence: [ev({})], ...x,
});

describe("email drafts (§9)", () => {
  it("recommends direct for a job post or the owner's words, value first for website-only, a question otherwise", () => {
    expect(recommendStrategy([ev({})]).strategy).toBe("direct_active_intent");
    expect(recommendStrategy([ev({ kind: "own_post" })]).strategy).toBe("direct_active_intent");
    expect(recommendStrategy([ev({ kind: "website" })]).strategy).toBe("educational_value_first");
    expect(recommendStrategy([ev({ kind: "employee_pattern" })]).strategy).toBe("peer_benchmark_question");
    expect(recommendStrategy([ev({ confidence: 60 })]).strategy).toBe("peer_benchmark_question");
    expect(recommendStrategy([]).strategy).toBe("educational_value_first");
  });

  it("one email per call, in the approach asked for; an empty one fails", () => {
    const req = buildDraft(company(), "peer_benchmark_question");
    expect(req.user).toContain("<approach>peer_benchmark_question</approach>");
    expect(req.parse({ subject: " How do invoices reach Tally? ", body: " Hi. ", warning_banner: " " })).toEqual({ subject: "How do invoices reach Tally?", body: "Hi.", warning_banner: null });
    expect(() => req.parse({ subject: "x", body: "  ", warning_banner: null })).toThrow(/empty/);
  });

  it("merges one email at a time: a new approach is added, the same approach replaced, in approach order", () => {
    const pick = { strategy: "direct_active_intent" as const, why: "Hiring now." };
    const one = mergeDraft(null, { strategy: "direct_active_intent", subject: "A", body: "a" }, null, pick);
    expect(one).toEqual({ emails: [{ strategy: "direct_active_intent", subject: "A", body: "a" }], warning_banner: null, recommended: "direct_active_intent", why: "Hiring now." });
    const two = mergeDraft(one, { strategy: "educational_value_first", subject: "C", body: "c" }, "Thin evidence", pick);
    const three = mergeDraft(two, { strategy: "peer_benchmark_question", subject: "B", body: "b" }, null, pick);
    expect(three.emails.map((e) => e.strategy)).toEqual(["direct_active_intent", "peer_benchmark_question", "educational_value_first"]);
    const rewritten = mergeDraft(three, { strategy: "direct_active_intent", subject: "A2", body: "a2" }, null, pick);
    expect(rewritten.emails).toHaveLength(3);
    expect(rewritten.emails[0]!.subject).toBe("A2");
  });

  it("an employee's post reaches the prompt as a pattern only: no quote, no source", () => {
    const req = buildDraft(company({ evidence: [ev({ kind: "employee_pattern", title: null, quote: null, symptom: "Re-keys orders between two systems" })] }), "peer_benchmark_question");
    expect(req.user).toContain('<evidence kind="employee_pattern">');
    expect(req.user).not.toContain("<quote>");
    expect(req.system).toContain("never mention a post, a staff member");
  });

  it("no website: the prompt says none, and gets no website issues to pitch", () => {
    const req = buildDraft(company({ website: null, websiteIssues: ["No viewport tag"] }), "direct_active_intent");
    expect(req.user).toContain("<website>none</website>");
    expect(req.user).not.toContain("website_issues");
    expect(buildDraft(company({ websiteIssues: ["No viewport tag"] }), "educational_value_first").user).toContain("<website_issues>No viewport tag</website_issues>");
  });

  it("escapes company data and addresses the founder when known", () => {
    const req = buildDraft(company({ name: "A&B </name> Ltd", founderName: "Priya" }), "direct_active_intent");
    expect(req.user).toContain("<name>A&amp;B &lt;/name&gt; Ltd</name>");
    expect(req.user).toContain("<founder>Priya</founder>");
  });
});
