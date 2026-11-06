import { describe, expect, it } from "vitest";
import { SEARCH_TITLES, type SlotHistory, allSlots, planRotation, slotState } from "../src/index.ts";

const NOW = new Date("2026-11-10T02:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const h = (x: Partial<SlotHistory> & Pick<SlotHistory, "vertical" | "country">): SlotHistory => ({ runs: 1, lastRunAt: daysAgo(1), fresh: 30, cards: 10, ...x });

describe("ingest-rotation planning (§4.1)", () => {
  it("45 slots from the §4.1b market matrix", () => {
    expect(allSlots()).toHaveLength(45);
  });

  it("never-run slots first, in matrix order, with the first search title", () => {
    const plan = planRotation([], 3, NOW);
    expect(plan).toEqual([
      { vertical: "real_estate", country: "in", title: SEARCH_TITLES.real_estate[0] },
      { vertical: "real_estate", country: "ae", title: SEARCH_TITLES.real_estate[0] },
      { vertical: "real_estate", country: "us", title: SEARCH_TITLES.real_estate[0] },
    ]);
  });

  it("then the slot run longest ago, with its next title", () => {
    const history = allSlots().map((s, i) => h({ ...s, lastRunAt: daysAgo(1 + (i === 7 ? 20 : 0)), runs: 1 }));
    const plan = planRotation(history, 1, NOW);
    expect(plan).toEqual([{ ...allSlots()[7]!, title: SEARCH_TITLES[allSlots()[7]!.vertical][1] }]);
  });

  it("low-yield slots wait an extra cycle; near-zero slots after 2 runs are off", () => {
    expect(slotState({ runs: 1, fresh: 40, cards: 2 })).toBe("low_yield");
    expect(slotState({ runs: 2, fresh: 40, cards: 1 })).toBe("off");
    expect(slotState({ runs: 2, fresh: 0, cards: 0 })).toBe("off");
    expect(slotState({ runs: 1, fresh: 40, cards: 10 })).toBe("normal");
    // Everything else ran yesterday; a low-yield slot run 10 days ago is not due (cycle = 15 days).
    const history = allSlots().map((s, i) => (i === 0 ? h({ ...s, lastRunAt: daysAgo(10), cards: 2, fresh: 40 }) : h({ ...s, lastRunAt: daysAgo(1) })));
    expect(planRotation(history, 1, NOW)[0]).not.toMatchObject(allSlots()[0]!);
    const off = allSlots().map((s, i) => (i === 0 ? h({ ...s, runs: 2, lastRunAt: daysAgo(30), cards: 0 }) : h({ ...s })));
    expect(planRotation(off, 45, NOW).map((p) => `${p.vertical}|${p.country}`)).not.toContain("real_estate|in");
  });
});
