// Health (agreed 2026-11-08): the latest drift check and the AI test set's runs, for the Health
// dashboard and the inbox banner.
import { DRIFT_METRICS, type DriftMetric } from "@bs/core";
import { asOperator } from "./operator.ts";

export interface DriftRow {
  metric: DriftMetric;
  label: string;
  kind: "share" | "ratio";
  window: number | null; // last 7 days
  base: number | null; // the 14 days before
  windowN: number;
  baseN: number;
  verdict: "ok" | "moved" | "too_few";
  direction: "up" | "down" | null;
  worse: boolean;
}

export interface EvalRunRow {
  created_at: string;
  model: string;
  prompt_hash: string;
  cases: number;
  pain_precision: number | null;
  pain_recall: number | null;
  lead_precision: number | null;
  lead_recall: number | null;
  agreement: number;
  disagreements: number;
}

export interface Health {
  day: string | null;
  drift: DriftRow[];
  evals: EvalRunRow[]; // newest first
  labelled: { lead: number; pain: number; none: number };
  // The latest run's disagreements, with the labelled post (no names: eval_cases is anonymised).
  disagreements: { text: string; label: string; ai: string; why: string }[];
}

export function loadHealth(): Promise<Health> {
  return asOperator(async (c) => {
    const rows = (
      await c.query<{ day: string; metric: DriftMetric; window_num: string; window_den: string; base_num: string; base_den: string; verdict: DriftRow["verdict"]; direction: DriftRow["direction"]; worse: boolean }>(
        `select to_char(d.day, 'YYYY-MM-DD') as day, d.metric, d.window_num, d.window_den, d.base_num, d.base_den, d.verdict, d.direction, d.worse
           from drift_checks d where d.day = (select max(day) from drift_checks)`,
      )
    ).rows;
    const ratio = (n: string, d: string) => (Number(d) > 0 ? Number(n) / Number(d) : null);
    const drift = (Object.keys(DRIFT_METRICS) as DriftMetric[]).flatMap((m) => {
      const r = rows.find((x) => x.metric === m);
      return r
        ? [{ metric: m, ...DRIFT_METRICS[m], window: ratio(r.window_num, r.window_den), base: ratio(r.base_num, r.base_den),
            windowN: Number(r.window_den), baseN: Number(r.base_den), verdict: r.verdict, direction: r.direction, worse: r.worse }]
        : [];
    });
    const evals = (
      await c.query<EvalRunRow>(
        `select created_at, model, prompt_hash, cases, (score -> 'pain' ->> 'precision')::float pain_precision, (score -> 'pain' ->> 'recall')::float pain_recall,
                (score -> 'lead' ->> 'precision')::float lead_precision, (score -> 'lead' ->> 'recall')::float lead_recall,
                (score ->> 'agreement')::float agreement, jsonb_array_length(score -> 'disagreements') disagreements
           from eval_runs order by created_at desc limit 20`,
      )
    ).rows;
    const labelled = { lead: 0, pain: 0, none: 0 };
    for (const r of (await c.query<{ label: keyof typeof labelled; n: number }>("select label, count(*)::int n from eval_cases group by 1")).rows) labelled[r.label] = r.n;
    const disagreements = (
      await c.query<{ text: string; label: string; ai: string; why: string }>(
        `select ec.text, d ->> 'label' label, case when (d ->> 'lead')::boolean then 'lead' when (d ->> 'pain')::boolean then 'pain' else 'none' end ai, d ->> 'why' why
           from (select score from eval_runs order by created_at desc limit 1) r
           cross join jsonb_array_elements(r.score -> 'disagreements') d
           join eval_cases ec on ec.id = (d ->> 'id')::uuid`,
      )
    ).rows;
    return { day: rows[0]?.day ?? null, drift, evals, labelled, disagreements };
  });
}

// The inbox banner: numbers that moved at the latest check, worst first.
export async function movedNumbers(): Promise<DriftRow[]> {
  const h = await loadHealth();
  return h.drift.filter((r) => r.verdict === "moved").sort((a, b) => Number(b.worse) - Number(a.worse));
}

export const healthValue = (r: Pick<DriftRow, "kind">, v: number | null) =>
  v === null ? "—" : r.kind === "ratio" ? `$${v.toFixed(4)}` : `${Math.round(v * 100)}%`;
