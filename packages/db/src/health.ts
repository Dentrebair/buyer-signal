// Drift check and AI test set (migrations 0018, 0019): the counts behind each health number, the
// day's verdicts, and the labelled posts with their eval runs.
import { type DriftCounts, type DriftMetric, type DriftResult, type EvalLabel, DRIFT_BASE_DAYS, DRIFT_WINDOW_DAYS, anonymise } from "@bs/core";
import type pg from "pg";
import type { Db } from "./pool.ts";

const DAY = 86_400_000;
type Periods = { w: DriftCounts; b: DriftCounts };

// Counts for the last DRIFT_WINDOW_DAYS ("w") and the DRIFT_BASE_DAYS before them ("b"). Each
// query tags its rows by period with the same two bounds; rows older than both are left out.
export async function driftCounts(db: Db, now: Date): Promise<Record<DriftMetric, Periods>> {
  const w = new Date(now.getTime() - DRIFT_WINDOW_DAYS * DAY);
  const b = new Date(w.getTime() - DRIFT_BASE_DAYS * DAY);
  const period = (col: string) => `case when ${col} >= $1 then 'w' when ${col} >= $2 then 'b' end`;
  const rows = async (sql: string) =>
    (await db.query<{ p: "w" | "b" | null } & Record<string, string>>(sql, [w, b, now])).rows.filter((r) => r.p);
  const out = {} as Record<DriftMetric, Periods>;
  const zero = (): Periods => ({ w: { num: 0, den: 0 }, b: { num: 0, den: 0 } });
  const put = (m: DriftMetric, p: "w" | "b", num: unknown, den: unknown) => ((out[m] ??= zero())[p] = { num: Number(num), den: Number(den) });
  for (const m of ["li_pain_rate", "li_card_rate", "li_no_market", "ai_error_rate", "reject_rate", "check_found_rate", "ai_cost_per_card"] as const) out[m] = zero();

  for (const r of await rows(
    `select ${period("created_at")} p,
            count(*) filter (where status = 'read' and has_pain) pain, count(*) filter (where status = 'read') read,
            count(*) filter (where has_pain and card_outcome = 'card') card,
            count(*) filter (where has_pain and card_outcome = 'no_market') no_market,
            count(*) filter (where has_pain and card_outcome is not null and card_outcome <> 'checking') decided,
            count(*) filter (where status = 'ai_error' or card_outcome = 'ai_error') err, count(*) filter (where status <> 'reading') done
       from li_posts where created_at >= $2 and created_at < $3 group by 1`,
  )) {
    put("li_pain_rate", r.p!, r.pain, r.read);
    put("li_card_rate", r.p!, r.card, r.decided);
    put("li_no_market", r.p!, r.no_market, r.decided);
    put("ai_error_rate", r.p!, r.err, r.done);
  }
  // Judged cards, by when the card was made: a verdict can come days later, so the last week
  // fills in as the operator works through it.
  for (const r of await rows(
    `select ${period("created_at")} p,
            count(*) filter (where status = 'rejected' and rejection_reason in ('not_real_pain', 'wrong_company')) rejected,
            count(*) filter (where status in ('actioned', 'rejected')) judged
       from companies where created_at >= $2 and created_at < $3 group by 1`,
  ))
    put("reject_rate", r.p!, r.rejected, r.judged);
  for (const r of await rows(
    `select ${period("(company_check ->> 'checkedAt')::timestamptz")} p,
            count(*) filter (where company_check ->> 'domain' is not null) found, count(*) checks
       from companies where company_check ? 'checkedAt'
        and (company_check ->> 'checkedAt')::timestamptz >= $2 and (company_check ->> 'checkedAt')::timestamptz < $3 group by 1`,
  ))
    put("check_found_rate", r.p!, r.found, r.checks);
  const spend = await rows(
    `select ${period("created_at")} p, sum(cost_usd) usd from spend_events
      where provider = 'openrouter' and created_at >= $2 and created_at < $3 group by 1`,
  );
  const cards = await rows(
    `select ${period("created_at")} p, count(*) n from challenges
      where source_type in ('job_post', 'linkedin_post') and created_at >= $2 and created_at < $3 group by 1`,
  );
  for (const p of ["w", "b"] as const)
    put("ai_cost_per_card", p, spend.find((r) => r.p === p)?.usd ?? 0, cards.find((r) => r.p === p)?.n ?? 0);
  return out;
}

// One row per metric per day; a re-run the same day replaces it.
export async function saveDriftChecks(c: pg.PoolClient | Db, day: string, results: DriftResult[]): Promise<void> {
  for (const r of results)
    await c.query(
      `insert into drift_checks (day, metric, window_num, window_den, base_num, base_den, verdict, direction, worse)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (day, metric) do update set window_num = $3, window_den = $4, base_num = $5, base_den = $6, verdict = $7,
         direction = $8, worse = $9, created_at = now()`,
      [day, r.metric, r.window.num, r.window.den, r.base.num, r.base.den, r.verdict, r.direction, r.worse],
    );
}

// ── AI test set ─────────────────────────────────────────────────────────────
export interface StoredEvalCase {
  id: string;
  text: string;
  headline: string | null;
  authorType: "person" | "company";
  label: EvalLabel;
}

export async function evalCases(db: Db): Promise<StoredEvalCase[]> {
  return (
    await db.query<StoredEvalCase>(
      `select id, text, headline, author_type "authorType", label from eval_cases where kind = 'li_post' order by created_at`,
    )
  ).rows;
}

// Labels a LinkedIn post for the test set, copying it without the author's name or emails.
// Runs as the operator (RLS: eval_cases is theirs to change).
export async function labelLiPost(c: pg.PoolClient, liPostId: string, label: EvalLabel | null): Promise<boolean> {
  if (label === null) return ((await c.query("delete from eval_cases where li_post_id = $1", [liPostId])).rowCount ?? 0) > 0;
  const p = (
    await c.query<{ body: string; author_name: string | null; author_headline: string | null; author_type: string }>(
      "select body, author_name, author_headline, author_type from li_posts where id = $1",
      [liPostId],
    )
  ).rows[0];
  if (!p) return false;
  await c.query(
    `insert into eval_cases (li_post_id, text, headline, author_type, label) values ($1, $2, $3, $4, $5)
     on conflict (li_post_id) do update set label = $5, updated_at = now()`,
    [liPostId, anonymise(p.body, p.author_name), p.author_headline && anonymise(p.author_headline, p.author_name), p.author_type, label],
  );
  return true;
}

export async function saveEvalRun(db: Db, x: { model: string; promptHash: string; cases: number; score: object; costUsd: number }): Promise<void> {
  await db.query("insert into eval_runs (kind, model, prompt_hash, cases, score, cost_usd) values ('li_post', $1, $2, $3, $4, $5)", [
    x.model,
    x.promptHash,
    x.cases,
    x.score,
    x.costUsd,
  ]);
}
