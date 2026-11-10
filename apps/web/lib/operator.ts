// Every UI read and write runs as the `authenticated` role, so the RLS rules of §11 (operator
// may read, and may change only status / rejection_reason / actioned_at) hold for the UI too.
import { headers } from "next/headers";
import type pg from "pg";
import { createPool, withTransaction } from "@bs/db";

const g = globalThis as unknown as { __bsPool?: pg.Pool };
// Session pooler allows 60 connections in total; web keeps 3 (§12 item 7).
const pool = (g.__bsPool ??= createPool(3));

// Single-user sign-in (Sprint 1 item 2) is not built yet, so the inbox only runs in local dev.
// The Host header is client-controlled, so it is a second check, not the guard: the guard is
// `npm run dev` binding to 127.0.0.1 and production refusing outright.
async function assertLocal(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("The inbox is disabled in production until sign-in exists.");
  const host = ((await headers()).get("host") ?? "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error("The inbox only runs on localhost until sign-in exists.");
}

export async function asOperator<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  await assertLocal();
  return withTransaction(pool, async (c) => {
    // One round trip for both (≈ 150 ms each to the database). The timeout: a page request that
    // stalls mid-transaction (seen 2026-11-08: two held 17 minutes) would keep one of the 3
    // connections and its locks for ever; the database ends it instead.
    await c.query("set local role authenticated; set local idle_in_transaction_session_timeout = '30s'");
    return fn(c);
  });
}

// /roast (§8) is the one public page: it runs as bs_roast (migration 0029), which can only call
// request_roast and roast_result, so a visitor's request can read or change nothing else. No
// localhost check: it is meant to work once deployed.
export async function asRoastVisitor<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (c) => {
    await c.query("set local role bs_roast; set local idle_in_transaction_session_timeout = '30s'");
    return fn(c);
  });
}
