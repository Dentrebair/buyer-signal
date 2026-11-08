import { describe, expect, it } from "vitest";
import { rawPath, stripPersonal } from "../src/index.ts";

describe("raw payload archive (Q64)", () => {
  it("Indeed: drops named people and street addresses, masks emails and phone numbers in the text", () => {
    const [out] = stripPersonal("indeed", [
      {
        title: "AP Clerk",
        employer: { name: "Acme", ceoName: "Pat Example", corporateWebsite: "https://acme.example" },
        location: { city: "Austin", streetAddress: "1 Main St" },
        description: { text: "Send CVs to pat@acme.example or call +1 (512) 555-0100." },
      },
    ]) as Record<string, any>[];
    expect(out).toEqual({
      title: "AP Clerk",
      employer: { name: "Acme", corporateWebsite: "https://acme.example" },
      location: { city: "Austin" },
      description: { text: "Send CVs to [email] or call [phone]." },
    });
  });

  it("LinkedIn: keeps the text, dates and counts, never who wrote it", () => {
    const [post, comment] = stripPersonal("li_posts", [
      { type: "post", id: "1", content: "We key invoices by hand", author: { type: "profile", name: "Pat", linkedinUrl: "https://x", info: "CFO", avatar: { url: "u" } }, engagement: { likes: 3 }, comments: [{ x: 1 }] },
      { type: "comment", id: "2", postId: "1", commentary: "Same", actor: { type: "profile", name: "Sam", position: "AP lead", linkedinUrl: "https://y", author: false } },
    ]) as Record<string, any>[];
    expect(post).toEqual({ type: "post", id: "1", content: "We key invoices by hand", author: { type: "profile", author: undefined }, engagement: { likes: 3 }, comments: [] });
    expect(comment).toEqual({ type: "comment", id: "2", postId: "1", commentary: "Same", actor: { type: "profile", author: false } });
  });

  it("files by source, day and run", () => {
    expect(rawPath({ source: "indeed", day: "2026-11-08", runId: "r1", part: "25" })).toBe("indeed/2026-11-08/r1-25.json.gz");
  });
});
