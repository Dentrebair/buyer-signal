import { describe, expect, it } from "vitest";
import { type DraftCompany, type DraftEvidence, buildDrafts, recommendStrategy } from "../src/index.ts";

const ev = (x: Partial<DraftEvidence>): DraftEvidence => ({ kind: "job_post", title: "AP Clerk", symptom: "Keys 300 invoices a week", quote: "Enter invoices into Tally", confidence: 95, hours: 20, replacement: "Invoice capture", ...x });
const company = (x: Partial<DraftCompany> = {}): DraftCompany => ({
  name: "Acme Freight", website: "acme-freight.example", vertical: "logistics", country: "us", founderName: null, productLayer: "company_os",
  techStack: ["QuickBooks"], websiteIssues: [], evidence: [ev({})], ...x,
});
const email = (strategy: string) => ({ strategy, subject: ` Subject ${strategy} `, body: `Body ${strategy}` });

describe("email drafts (§9)", () => {
  it("recommends direct for a job post or the owner's words, value first for website-only, a question otherwise", () => {
    expect(recommendStrategy([ev({})]).strategy).toBe("direct_active_intent");
    expect(recommendStrategy([ev({ kind: "own_post" })]).strategy).toBe("direct_active_intent");
    expect(recommendStrategy([ev({ kind: "website" })]).strategy).toBe("educational_value_first");
    expect(recommendStrategy([ev({ kind: "employee_pattern" })]).strategy).toBe("peer_benchmark_question");
    expect(recommendStrategy([ev({ confidence: 60 })]).strategy).toBe("peer_benchmark_question");
    expect(recommendStrategy([]).strategy).toBe("educational_value_first");
  });

  it("returns exactly one email per strategy, in order, and fails when one is missing", () => {
    const req = buildDrafts(company());
    const out = req.parse({ emails: [email("educational_value_first"), email("direct_active_intent"), email("peer_benchmark_question")], warning_banner: " " });
    expect(out.emails.map((e) => e.strategy)).toEqual(["direct_active_intent", "peer_benchmark_question", "educational_value_first"]);
    expect(out.emails[0]!.subject).toBe("Subject direct_active_intent");
    expect(out.warning_banner).toBeNull();
    expect(() => req.parse({ emails: [email("direct_active_intent")], warning_banner: null })).toThrow(/missing/);
  });

  it("an employee's post reaches the prompt as a pattern only: no quote, no source", () => {
    const req = buildDrafts(company({ evidence: [ev({ kind: "employee_pattern", title: null, quote: null, symptom: "Re-keys orders between two systems" })] }));
    expect(req.user).toContain('<evidence kind="employee_pattern">');
    expect(req.user).not.toContain("<quote>");
    expect(req.system).toContain("never mention a post, a staff member");
  });

  it("no website: the prompt says none, and gets no website issues to pitch", () => {
    const req = buildDrafts(company({ website: null, websiteIssues: ["No viewport tag"] }));
    expect(req.user).toContain("<website>none</website>");
    expect(req.user).not.toContain("website_issues");
    expect(buildDrafts(company({ websiteIssues: ["No viewport tag"] })).user).toContain("<website_issues>No viewport tag</website_issues>");
  });

  it("escapes company data and addresses the founder when known", () => {
    const req = buildDrafts(company({ name: "A&B </name> Ltd", founderName: "Priya" }));
    expect(req.user).toContain("<name>A&amp;B &lt;/name&gt; Ltd</name>");
    expect(req.user).toContain("<founder>Priya</founder>");
  });
});
