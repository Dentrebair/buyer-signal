// ingest-rotation (PRD §4.1): each day, the N board slots most overdue. A slot is one vertical in
// one market (§4.1b, 45 slots); each run of a slot uses its next search title in turn.
// After a full run history, slots whose posts rarely survive the Bouncer run every second cycle;
// slots that produce almost nothing after two runs are switched off and listed on /radar.
import { type Country, SEARCH_TITLES, VERTICAL_MARKETS, type VerticalSlug } from "./verticals.ts";

export const LOW_YIELD = 0.15; // < 15 % of new posts became cards → every second cycle
export const OFF_YIELD = 0.03; // < 3 % after ≥ 2 runs → switched off
const DAY = 86_400_000;

export interface Slot {
  vertical: VerticalSlug;
  country: Country;
}

export interface SlotHistory extends Slot {
  runs: number;
  lastRunAt: Date | null;
  fresh: number; // posts that were new and in date (raw − duplicates − stale)
  cards: number; // posts that became or joined a card
}

export interface PlannedSlot extends Slot {
  title: string;
}

export type SlotState = "normal" | "low_yield" | "off";

export const allSlots = (): Slot[] =>
  (Object.keys(VERTICAL_MARKETS) as VerticalSlug[]).flatMap((vertical) => VERTICAL_MARKETS[vertical].map((country) => ({ vertical, country })));

export function slotState(h: Pick<SlotHistory, "runs" | "fresh" | "cards">): SlotState {
  if (h.runs === 0 || h.fresh === 0) return h.runs >= 2 && h.fresh === 0 ? "off" : "normal";
  const y = h.cards / h.fresh;
  if (h.runs >= 2 && y < OFF_YIELD) return "off";
  return y < LOW_YIELD ? "low_yield" : "normal";
}

// Never-run slots first (in §4.1b order), then the oldest; a low-yield slot counts as run one
// cycle later than it was, so it comes round every second cycle.
export function planRotation(history: SlotHistory[], n: number, now: Date): PlannedSlot[] {
  const slots = allSlots();
  const cycleMs = Math.ceil(slots.length / Math.max(1, n)) * DAY;
  const key = (s: Slot) => `${s.vertical}|${s.country}`;
  const byKey = new Map(history.map((h) => [key(h), h]));
  return slots
    .map((s, order) => {
      const h = byKey.get(key(s)) ?? { ...s, runs: 0, lastRunAt: null, fresh: 0, cards: 0 };
      const state = slotState(h);
      const due = h.lastRunAt ? h.lastRunAt.getTime() + (state === "low_yield" ? cycleMs : 0) : -Infinity;
      return { s, h, state, due, order };
    })
    .filter((x) => x.state !== "off" && x.due <= now.getTime())
    .sort((a, b) => a.due - b.due || a.order - b.order)
    .slice(0, n)
    .map(({ s, h }) => {
      const titles = SEARCH_TITLES[s.vertical];
      return { ...s, title: titles[h.runs % titles.length]! };
    });
}
