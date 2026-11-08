import { describe, expect, it } from "vitest";
import { anonymise, compareDrift, scoreEval } from "../src/index.ts";

describe("drift check", () => {
  it("flags a share that moved more than chance explains, and says whether that is worse", () => {
    // Cards from pain posts: 30 % before, 8 % now, on enough posts.
    const fell = compareDrift("li_card_rate", { num: 4, den: 50 }, { num: 30, den: 100 });
    expect(fell).toMatchObject({ verdict: "moved", direction: "down", worse: true });
    // A jump is flagged too (the AI may have turned lenient), but it is not "worse".
    expect(compareDrift("li_card_rate", { num: 30, den: 50 }, { num: 10, den: 100 })).toMatchObject({ verdict: "moved", direction: "up", worse: false });
    // Same rate give or take noise: steady.
    expect(compareDrift("li_pain_rate", { num: 12, den: 40 }, { num: 25, den: 90 }).verdict).toBe("ok");
  });

  it("does not judge on too few cases", () => {
    expect(compareDrift("li_card_rate", { num: 0, den: 10 }, { num: 30, den: 100 }).verdict).toBe("too_few");
    expect(compareDrift("reject_rate", { num: 0, den: 0 }, { num: 0, den: 0 }).verdict).toBe("too_few");
    expect(compareDrift("ai_cost_per_card", { num: 0.1, den: 3 }, { num: 0.1, den: 20 }).verdict).toBe("too_few");
  });

  it("AI cost per card: flagged when it doubles or halves", () => {
    expect(compareDrift("ai_cost_per_card", { num: 0.2, den: 10 }, { num: 0.18, den: 20 })).toMatchObject({ verdict: "moved", direction: "up", worse: true });
    expect(compareDrift("ai_cost_per_card", { num: 0.1, den: 10 }, { num: 0.15, den: 10 }).verdict).toBe("ok");
  });
});

describe("AI test set", () => {
  it("scores pain and lead against the operator's labels and lists the disagreements", () => {
    const s = scoreEval(
      [
        { id: "a", label: "lead" },
        { id: "b", label: "pain" },
        { id: "c", label: "none" },
        { id: "d", label: "lead" },
        { id: "e", label: "none" }, // not read (an AI error): left out, not counted wrong
      ],
      [
        { id: "a", pain: true, lead: true, why: "card" },
        { id: "b", pain: true, lead: true, why: "card" }, // a wrong lead
        { id: "c", pain: false, lead: false, why: "no_pain" },
        { id: "d", pain: true, lead: false, why: "no_market" }, // a missed lead
      ],
    );
    expect(s.cases).toBe(4);
    expect(s.pain).toMatchObject({ tp: 3, fp: 0, fn: 0, tn: 1, precision: 1, recall: 1 });
    expect(s.lead).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5 });
    expect(s.agreement).toBe(0.5);
    expect(s.disagreements.map((d) => [d.id, d.why])).toEqual([["b", "card"], ["d", "no_market"]]);
  });

  it("a labelled post keeps no name and no email", () => {
    expect(anonymise("Pat Example here: Pat runs ops, mail pat@acme.com. Patrick is not Pat.", "Pat Example")).toBe(
      "the author here: the author runs ops, mail [email]. Patrick is not the author.",
    );
    expect(anonymise("No name to strip (a+b)", null)).toBe("No name to strip (a+b)");
    // One pass, and the surname stays: it is often the company's name.
    expect(anonymise("Dana Smith, ops at Smith Logistics. Thanks, Dana", "Dana Smith")).toBe("the author, ops at Smith Logistics. Thanks, the author");
  });
});
