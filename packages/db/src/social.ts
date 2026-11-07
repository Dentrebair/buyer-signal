// Social digest results (migrations 0008, 0009): one row per post the AI reads, with its verdict.
import type { Db } from "./pool.ts";

// Posts the AI reads only (migration 0009); free drops are counted on the run, not stored.
export type SocialOutcome = "checking" | "stance" | "no_company" | "no_fit" | "too_large" | "card";

// Safe to run twice (a fetch retry): the first verdict for a result stays.
export async function recordSocialResult(db: Db, x: { runId: string; url: string; snippet: string; postedAt: Date | null; outcome: SocialOutcome }): Promise<void> {
  await db.query(
    `insert into social_results (run_id, url, snippet, posted_at, outcome) values ($1, $2, $3, $4, $5)
     on conflict (run_id, url) do nothing`,
    [x.runId, x.url, x.snippet.slice(0, 2000), x.postedAt, x.outcome],
  );
}

export async function setSocialOutcome(
  db: Db,
  x: { runId: string; url: string; outcome: SocialOutcome; authorRelation?: string | null; stance?: string | null; symptom?: string | null },
): Promise<void> {
  await db.query(
    `update social_results set outcome = $3, author_relation = coalesce($4, author_relation), stance = coalesce($5, stance), symptom = coalesce($6, symptom)
      where run_id = $1 and url = $2`,
    [x.runId, x.url, x.outcome, x.authorRelation ?? null, x.stance ?? null, x.symptom?.slice(0, 250) ?? null],
  );
}

// Leads (and posts still being read) for the 21-day post window (§4.3); the AI's drops for 7
// days, long enough to check its judgement.
export const AI_DROPS: SocialOutcome[] = ["stance", "no_company", "no_fit", "too_large"];
export async function purgeSocialResults(db: Db, days = 21, dropDays = 7): Promise<number> {
  const r = await db.query(
    `delete from social_results
      where created_at < now() - make_interval(days => $1)
         or (outcome = any($3) and created_at < now() - make_interval(days => $2))`,
    [days, dropDays, AI_DROPS],
  );
  return r.rowCount ?? 0;
}
