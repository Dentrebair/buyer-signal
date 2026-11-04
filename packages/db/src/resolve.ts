// Resolve queue (PRD §5.1 step 5c): posts waiting for a website search, best score first.
import type { Db } from "./pool.ts";

export interface ResolveRow {
  natural_id: string;
  run_id: string | null;
  cache_key: string;
  company_name: string;
  city: string | null;
  country: "in" | "ae" | "us";
  payload: unknown;
}

// false = already queued (a retried extract job).
export async function enqueueResolve(
  db: Db,
  x: { naturalId: string; runId: string; cacheKey: string; company: string; city: string | null; country: string; score: number; postedAt: Date | null; payload: object },
): Promise<boolean> {
  const r = await db.query(
    `insert into resolve_queue (natural_id, run_id, cache_key, company_name, city, country, provisional_score, posted_at, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (natural_id) do nothing`,
    [x.naturalId, x.runId, x.cacheKey, x.company, x.city, x.country, x.score, x.postedAt, JSON.stringify(x.payload)],
  );
  return r.rowCount === 1;
}

// Pending posts past the 21-day signal age (§4.3): marked stale, returned so their runs' counters move.
export async function expireStaleResolves(db: Db, now: Date, maxAgeDays: number): Promise<{ run_id: string | null }[]> {
  const r = await db.query<{ run_id: string | null }>(
    `update resolve_queue set status = 'stale', finished_at = $1
      where status = 'pending' and coalesce(posted_at, created_at) < $1::timestamptz - make_interval(days => $2)
      returning run_id`,
    [now, maxAgeDays],
  );
  return r.rows;
}

// Paid searches already run in the UTC day containing `now`.
export async function searchesToday(db: Db, now: Date): Promise<number> {
  const r = await db.query<{ n: number }>(
    "select count(*)::int n from resolve_queue where searched_at >= date_trunc('day', $1::timestamptz at time zone 'utc') at time zone 'utc'",
    [now],
  );
  return r.rows[0]!.n;
}

export async function pendingResolves(db: Db, limit: number): Promise<ResolveRow[]> {
  const r = await db.query<ResolveRow>(
    `select natural_id, run_id, cache_key, company_name, city, country, payload from resolve_queue
      where status = 'pending' order by provisional_score desc, created_at limit $1`,
    [limit],
  );
  return r.rows;
}

export async function markSearched(db: Db, naturalId: string, now: Date): Promise<void> {
  await db.query("update resolve_queue set searched_at = coalesce(searched_at, $2) where natural_id = $1", [naturalId, now]);
}

// true = this call moved the row out of 'pending' (so its counters are bumped once).
export async function finishResolve(db: Db, naturalId: string, status: "resolved" | "unresolved", now: Date): Promise<boolean> {
  const r = await db.query("update resolve_queue set status = $2, finished_at = $3 where natural_id = $1 and status = 'pending'", [naturalId, status, now]);
  return r.rowCount === 1;
}
