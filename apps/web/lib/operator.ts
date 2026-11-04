// Every UI read and write runs as the `authenticated` role, so the RLS rules of §11 (operator
// may read, and may change only status / rejection_reason / actioned_at) hold for the UI too.
import { headers } from "next/headers";
import type pg from "pg";
import { createPool, withTransaction } from "@bs/db";

const g = globalThis as unknown as { __bsPool?: pg.Pool };
// Session pooler allows 60 connections in total; web keeps 3 (§12 item 7).
const pool = (g.__bsPool ??= createPool(3));

// Single-user sign-in (Sprint 1 item 2) is not built yet, so the app only answers on this machine.
export async function assertLocal(): Promise<void> {
  const host = ((await headers()).get("host") ?? "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error("The inbox only runs on localhost until sign-in exists.");
}

export async function asOperator<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  await assertLocal();
  return withTransaction(pool, async (c) => {
    await c.query("set local role authenticated");
    return fn(c);
  });
}
