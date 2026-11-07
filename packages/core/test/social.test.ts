import { describe, expect, it } from "vitest";
import { SOCIAL_KEYWORD, SOCIAL_TOPICS, TOPICS_PER_RUN, StartSocialRun, compileAtoms, gateSnippet, linkedinPost, socialQuery, weightsFor } from "../src/index.ts";

const at = (d: Date) => (BigInt(d.getTime()) << 22n).toString().padStart(19, "0");

describe("Social digest: LinkedIn posts (§4.1a)", () => {
  it("reads the post id and its time from the URL", () => {
    const when = new Date("2026-11-01T10:00:00Z");
    const p = linkedinPost(`https://www.linkedin.com/posts/acme-freight_we-still-key-activity-${at(when)}-AbCd`);
    expect(p).toMatchObject({ id: at(when), slug: "acme-freight" });
    expect(p!.postedAt.toISOString()).toBe(when.toISOString());
    // The real sample from 2026-11-06 decodes to a date inside the 21-day window it was searched in.
    expect(linkedinPost("https://www.linkedin.com/posts/tvarana_linkedinpoll-netsuite-aiocr-activity-7520511397525606400-oqPt")!.postedAt.getUTCFullYear()).toBe(2026);
  });

  it("only LinkedIn posts over https; profiles, articles and look-alike hosts are not posts", () => {
    const id = at(new Date());
    expect(linkedinPost(`https://www.linkedin.com/in/someone`)).toBeNull();
    expect(linkedinPost(`https://www.linkedin.com/pulse/a-story-${id}`)).toBeNull();
    expect(linkedinPost(`https://evil-linkedin.com/posts/x_y-activity-${id}-a`)).toBeNull();
    expect(linkedinPost(`http://www.linkedin.com/posts/x_y-activity-${id}-a`)).toBeNull();
    expect(linkedinPost(`javascript:alert(1)`)).toBeNull();
  });

  it("topic search: no phrasing required, rotates through the vertical's topics, vendor words excluded", () => {
    const first = socialQuery("logistics", { runIndex: 0 });
    expect(first.query).toMatch(/^site:linkedin\.com\/posts \("shipment tracking" OR /);
    expect(first.query).toContain("-automation");
    expect(first.query).not.toContain("-hiring"); // hiring posts can be implied signals
    expect(first.label.split(", ")).toHaveLength(TOPICS_PER_RUN);
    const second = socialQuery("logistics", { runIndex: 1 });
    expect(second.label.split(", ")[0]).toBe(SOCIAL_TOPICS.logistics[TOPICS_PER_RUN]);
    expect(socialQuery("logistics", { runIndex: SOCIAL_TOPICS.logistics.length / TOPICS_PER_RUN }).label).toBe(first.label); // wraps
    expect(socialQuery("logistics", { keyword: " detention ", runIndex: 3 })).toMatchObject({ label: "detention" });
  });

  it("keyword: plain words only, so it cannot add search operators", () => {
    expect(SOCIAL_KEYWORD.test("bills of lading")).toBe(true);
    expect(SOCIAL_KEYWORD.test('x" OR site:evil.com')).toBe(false);
    expect(SOCIAL_KEYWORD.test("-automation")).toBe(false);
    expect(StartSocialRun.parse({ vertical: "logistics", country: "us", pages: 1 }).keyword).toBeNull();
    expect(StartSocialRun.safeParse({ vertical: "logistics", keyword: "a(b)", country: "us", pages: 1 }).success).toBe(false);
  });

  it("implied posts keep evidence weight but score lower buying intent", () => {
    expect(weightsFor("linkedin_post", "founder_owner", "suffering")).toEqual({ E: 85, I: 90 });
    expect(weightsFor("linkedin_post", "founder_owner", "implied")).toEqual({ E: 85, I: 75 });
  });

  it("snippet gate: one work atom is enough, recruiters drop", () => {
    const t = compileAtoms({ AUTOMATABLE_TASK: ["data entry"], RECRUITER: ["our client is seeking"] });
    expect(gateSnippet("We still do all our data entry by hand", null, t).pass).toBe(true);
    expect(gateSnippet("Lovely weekend with the team", null, t)).toMatchObject({ pass: false, reason: "trie" });
    expect(gateSnippet("Our client is seeking help with data entry", null, t)).toMatchObject({ pass: false, reason: "recruiter" });
  });
});
