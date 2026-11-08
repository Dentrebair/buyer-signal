// Social digest results (migrations 0008, 0009): the Google digest's verdicts, read-only since it
// was retired on 2026-11-08 (§4.1d). Kept until they age out, as the history of its searches.
import type { Db } from "./pool.ts";

export type SocialOutcome = "checking" | "stance" | "no_company" | "no_fit" | "too_large" | "card" | "ai_error";

// Leads for the 21-day post window (§4.3); the AI's drops for 7 days.
export const AI_DROPS: SocialOutcome[] = ["stance", "no_company", "no_fit", "too_large", "ai_error"];
export async function purgeSocialResults(db: Db, days = 21, dropDays = 7): Promise<number> {
  const r = await db.query(
    `delete from social_results
      where created_at < now() - make_interval(days => $1)
         or (outcome = any($3) and created_at < now() - make_interval(days => $2))`,
    [days, dropDays, AI_DROPS],
  );
  return r.rowCount ?? 0;
}
