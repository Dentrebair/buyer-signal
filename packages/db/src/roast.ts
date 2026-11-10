// /roast (migration 0029, §8): the worker's side. The public page's side is two functions in the
// migration (request_roast, roast_result), run as bs_roast.
import type pg from "pg";
import type { RoastTeardown } from "@bs/core";
import type { Db } from "./pool.ts";

export interface RoastRequestRow {
  id: string;
  domain: string;
  email: string;
  email_verified: boolean;
  status: string;
  company_id: string | null;
}

export async function roastRequest(db: Db, id: string): Promise<RoastRequestRow | null> {
  return (await db.query<RoastRequestRow>("select id, domain, email, email_verified, status, company_id from roast_requests where id = $1", [id])).rows[0] ?? null;
}

// A verified inbound brings an actioned or rejected company back to the inbox (§8.1); an
// unverified one never changes its status. Same transaction as the inbound challenge.
export async function resurfaceVerifiedInbound(c: pg.PoolClient, companyId: string): Promise<void> {
  await c.query("update companies set status = 'new' where id = $1 and status <> 'new'", [companyId]);
}

export async function linkRoastCompany(c: pg.PoolClient, id: string, companyId: string): Promise<void> {
  await c.query("update roast_requests set company_id = $2 where id = $1", [id, companyId]);
}

export async function finishRoast(db: Db, x: { id: string; teardown: RoastTeardown | null; error: string | null; model: string | null; costUsd: number }): Promise<void> {
  await db.query(
    "update roast_requests set status = $2, teardown = $3, error = $4, model = $5, cost_usd = $6, finished_at = now() where id = $1 and status = 'queued'",
    [x.id, x.error ? "error" : "done", x.teardown, x.error?.slice(0, 300) ?? null, x.model, x.costUsd],
  );
}

// poll-runs: a roast still running after 10 minutes failed somewhere; requests (they hold an
// email) are kept 90 days, the lead stays on the company; rate hits are needed for an hour.
export async function expireRoasts(db: Db): Promise<number> {
  const a = await db.query("update roast_requests set status = 'error', error = 'Timed out', finished_at = now() where status = 'queued' and requested_at < now() - interval '10 minutes'");
  const b = await db.query("delete from roast_requests where requested_at < now() - interval '90 days'");
  const h = await db.query("delete from rate_hits where hit_at < now() - interval '1 day'");
  return (a.rowCount ?? 0) + (b.rowCount ?? 0) + (h.rowCount ?? 0);
}
