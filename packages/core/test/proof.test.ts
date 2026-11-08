import { describe, expect, it } from "vitest";
import { compileAtoms, matchSpans, painTypesOf } from "../src/index.ts";

const trie = compileAtoms({ AUTOMATABLE_TASK: ["data entry", "reconcil*"], DOCUMENT_FRICTION: ["scanned invoices"], INTEGRATION_DEBT: ["data entry into sap"] });

describe("Proof Viewer (§10.2)", () => {
  it("marks each matched phrase by its place in the original text, longest match first", () => {
    const text = "You'll do Data Entry into SAP, reconcile accounts, and file scanned   invoices.";
    const spans = matchSpans(text, null, trie);
    expect(spans.map((s) => [text.slice(s.start, s.end), s.category])).toEqual([
      ["Data Entry into SAP", "INTEGRATION_DEBT"], // the longer atom wins over "data entry"
      ["reconcile", "AUTOMATABLE_TASK"],
      ["scanned   invoices", "DOCUMENT_FRICTION"],
    ]);
  });

  it("keeps offsets right after an apostrophe inside a word", () => {
    const text = "We don't reconcile; the owner's team reconciles by hand.";
    expect(matchSpans(text, null, trie).map((s) => text.slice(s.start, s.end))).toEqual(["reconcile", "reconciles"]);
  });
});

describe("pain types (§10.1 filter)", () => {
  it("come from the matched categories; website findings are web", () => {
    expect(painTypesOf("job_post", ["AUTOMATABLE_TASK", "MANUAL_ROLE", "INTEGRATION_DEBT", "RECRUITER"])).toEqual(["manual_work", "integration_debt"]);
    expect(painTypesOf("linkedin_post", ["OWNER_DEPENDENCY"])).toEqual(["information_silo"]);
    expect(painTypesOf("dom_sniff", ["AUTOMATABLE_TASK"])).toEqual(["web"]);
    expect(painTypesOf("job_post", [])).toEqual([]);
  });
});
