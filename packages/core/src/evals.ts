// AI test set (agreed 2026-11-08): posts the operator labelled, re-read by the current prompt and
// model, so a prompt edit or a model update that changes the AI's judgement shows as a score
// before it shows as junk in the inbox. Pure: the eval script runs the AI, this scores it.

export type EvalLabel = "lead" | "pain" | "none"; // a card for the inbox | pain, but not a lead | no pain

export interface EvalCase {
  id: string;
  label: EvalLabel;
}
export interface EvalPrediction {
  id: string;
  pain: boolean;
  lead: boolean;
  why: string; // the card gate's outcome, for a disagreement list
}

export interface Rates {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null; // of what the AI said yes to, the share that was right
  recall: number | null; // of the real yeses, the share the AI found
}

export interface EvalScore {
  cases: number;
  pain: Rates;
  lead: Rates;
  agreement: number; // cases where the AI's pain and lead both match the label
  disagreements: { id: string; label: EvalLabel; pain: boolean; lead: boolean; why: string }[];
}

function rates(pairs: [expected: boolean, got: boolean][]): Rates {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const [e, g] of pairs) e ? (g ? tp++ : fn++) : g ? fp++ : tn++;
  return { tp, fp, fn, tn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null };
}

export function scoreEval(cases: EvalCase[], predictions: EvalPrediction[]): EvalScore {
  const byId = new Map(predictions.map((p) => [p.id, p]));
  const scored = cases.flatMap((c) => {
    const p = byId.get(c.id);
    return p ? [{ c, p }] : [];
  });
  const disagreements = scored
    .filter(({ c, p }) => p.pain !== (c.label !== "none") || p.lead !== (c.label === "lead"))
    .map(({ c, p }) => ({ id: c.id, label: c.label, pain: p.pain, lead: p.lead, why: p.why }));
  return {
    cases: scored.length,
    pain: rates(scored.map(({ c, p }) => [c.label !== "none", p.pain])),
    lead: rates(scored.map(({ c, p }) => [c.label === "lead", p.lead])),
    agreement: scored.length ? (scored.length - disagreements.length) / scored.length : 0,
    disagreements,
  };
}

// A labelled post keeps no name: emails go, and the author's full name and first name (posts are
// often signed with it) become "the author", in one pass. A surname alone stays: it is often the
// company's own name ("Smith Logistics"), which the read needs.
export function anonymise(text: string, authorName: string | null): string {
  const t = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]");
  const full = authorName?.trim().replace(/\s+/g, " ");
  const terms = [full, full?.split(" ")[0]].filter((x): x is string => !!x && x.length >= 3);
  if (!terms.length) return t;
  const alt = [...new Set(terms)].sort((a, b) => b.length - a.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return t.replace(new RegExp(`\\b(?:${alt})\\b`, "gi"), "the author");
}
