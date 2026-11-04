// Budget gate (PRD §5.3). `spend_counters` is the gate; `spend_events` is the audit record.
import type pg from "pg";
import type { LlmCallResult, LlmClient, LlmRequest, LlmTask } from "@bs/core";
import { monthKey } from "@bs/core";
import { type Db, withTransaction } from "./pool.ts";

export class BudgetExceededError extends Error {
  constructor(readonly key: string) {
    super(`spend cap reached for ${key}`);
  }
}

// Adds `amount` to the counter only if it stays within the cap. false = over cap.
export async function reserveSpend(db: Db, key: string, amount: number, capUsd: number): Promise<boolean> {
  await db.query("insert into spend_counters (key, total_usd, cap_usd) values ($1, 0, $2) on conflict (key) do update set cap_usd = excluded.cap_usd", [
    key,
    capUsd,
  ]);
  const r = await db.query(
    `update spend_counters set total_usd = total_usd + $2, updated_at = now()
      where key = $1 and total_usd + $2 <= cap_usd returning total_usd`,
    [key, amount],
  );
  return r.rowCount === 1;
}

export interface SpendEvent {
  provider: "apify" | "brave" | "openrouter" | "gemini";
  model?: string | null;
  units: number;
  costUsd: number;
  runId?: string | null;
  ref?: string | null;
}

// Replaces the reservation with the real cost and writes the event, in one transaction.
export async function settleSpend(pool: pg.Pool, key: string, reserved: number, event: SpendEvent | null): Promise<void> {
  await withTransaction(pool, async (c) => {
    await c.query("update spend_counters set total_usd = greatest(0, total_usd - $2 + $3), updated_at = now() where key = $1", [
      key,
      reserved,
      event?.costUsd ?? 0,
    ]);
    if (event) {
      await c.query(
        "insert into spend_events (provider, model, units, cost_usd, run_id, ref) values ($1, $2, $3, $4, $5, $6)",
        [event.provider, event.model ?? null, event.units, event.costUsd, event.runId ?? null, event.ref ?? null],
      );
    }
  });
}

// Wraps an LlmClient so every call reserves its worst case against `month:{YYYY-MM}` first.
export function gatedLlm(pool: pg.Pool, inner: LlmClient, opts: { monthlyCapUsd: number; now?: () => Date }): LlmClient {
  const now = opts.now ?? (() => new Date());
  return {
    worstCaseUsd: (task, input) => inner.worstCaseUsd(task, input),
    async json<T>(task: LlmTask, input: LlmRequest<T>): Promise<LlmCallResult<T>> {
      const key = monthKey(now());
      const reserved = await inner.worstCaseUsd(task, input);
      if (!(await reserveSpend(pool, key, reserved, opts.monthlyCapUsd))) throw new BudgetExceededError(key);
      try {
        const out = await inner.json(task, input);
        await settleSpend(pool, key, reserved, { provider: "openrouter", model: out.model, units: 1, costUsd: out.costUsd, ref: task });
        return out;
      } catch (e) {
        // A failed call can still have been billed (e.g. invalid output twice).
        const spent = Number((e as { costUsd?: number }).costUsd ?? 0);
        await settleSpend(pool, key, reserved, spent > 0 ? { provider: "openrouter", units: 1, costUsd: spent, ref: `${task}:failed` } : null);
        throw e;
      }
    },
  };
}
