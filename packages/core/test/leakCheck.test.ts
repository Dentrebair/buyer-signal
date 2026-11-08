import { describe, expect, it } from "vitest";
import { buildLeakCheck, gateJobPost, sampled, trieFor } from "../src/index.ts";

describe("leak check (audit-dropped, §6.3 step 6)", () => {
  it("samples a fixed ~2 % of drops: the same post always in or out", () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => `job:indeed:${i.toString(16)}`);
    const n = ids.filter((id) => sampled(id)).length;
    expect(n / ids.length).toBeGreaterThan(0.015);
    expect(n / ids.length).toBeLessThan(0.025);
    expect(ids.filter((id) => sampled(id))).toEqual(ids.filter((id) => sampled(id)));
  });

  it("keeps only phrases copied from the post, 2 to 6 words", () => {
    const req = buildLeakCheck({ title: "Office Admin", text: "You will key   Supplier Invoices into Sage every morning." });
    const out = req.parse({
      is_lead: true,
      reason: "Daily invoice keying",
      phrases: [
        { phrase: "key supplier invoices", category: "AUTOMATABLE_TASK" }, // spacing and case differ: still in the post
        { phrase: "process vendor bills", category: "AUTOMATABLE_TASK" }, // not in the post
        { phrase: "invoices", category: "AUTOMATABLE_TASK" }, // one word
      ],
    });
    expect(out.phrases).toEqual([{ phrase: "key supplier invoices", category: "AUTOMATABLE_TASK" }]);
    expect(req.parse({ is_lead: false, reason: "Field role", phrases: [{ phrase: "key supplier invoices", category: "AUTOMATABLE_TASK" }] }).phrases).toEqual([]);
  });

  it("an approved phrase joins the trie: a post the trie dropped now passes", () => {
    const post = { title: "Office Coordinator", description: "Every morning you will reconcile the zorbex ledger and update the frobnitz tracker for the owners." };
    expect(gateJobPost(post, "logistics", trieFor("logistics", null)).pass).toBe(false);
    const approved = { version: "2:1", core: {}, vertical: { logistics: { AUTOMATABLE_TASK: ["reconcile the zorbex ledger", "update the frobnitz tracker"] } } };
    expect(gateJobPost(post, "logistics", trieFor("logistics", approved)).pass).toBe(true);
    expect(gateJobPost(post, "accounting", trieFor("accounting", approved)).pass).toBe(false); // another vertical's phrases do not apply
  });
});
