// Worker: runs every pipeline step on pg-boss (PRD §3, §5.2, §5.3a).
// Usage: npm run worker
import { PgBoss } from "pg-boss";
import { z } from "zod";
import { type QueueName, ApifyRunEvent, ExtractLlm, FetchDataset, Q, StartBoardRun } from "@bs/core";
import { BudgetExceededError, createPool, gatedLlm } from "@bs/db";
import { ApifyClient, OpenRouterClient, ProviderError } from "@bs/integrations";
import { type Deps, extractLlm, fetchDataset, onApifyRunEvent, pollRuns, reconcileApify, startBoardRun } from "./jobs.ts";

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    APIFY_CYCLE_CAP_USD: z.coerce.number().positive().default(4.5),
    MONTHLY_CAP_USD: z.coerce.number().positive().default(20),
  })
  .parse(process.env);

const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
// Errors from pg / pg-boss are often plain objects; keep the fields that say what happened.
const describe = (e: unknown) =>
  e instanceof Error
    ? { error: e.message, code: (e as { code?: string }).code, queue: (e as { queue?: string }).queue }
    : { error: typeof e === "object" ? JSON.stringify(e).slice(0, 500) : String(e) };

// pg-boss gets its own small pool; app queries use another (session pooler: 60 total, §12 item 7).
const boss = new PgBoss({ connectionString: env.DATABASE_URL, max: 3, application_name: "bs-worker-boss" });
const pool = createPool(2);

const deps: Deps = {
  pool,
  apify: new ApifyClient(),
  llm: gatedLlm(pool, new OpenRouterClient(), { monthlyCapUsd: env.MONTHLY_CAP_USD }),
  send: (queue, data, opts) => boss.send(queue, data, opts ?? {}),
  settings: { apifyCycleCapUsd: env.APIFY_CYCLE_CAP_USD },
  now: () => new Date(),
  log,
};

// §5.3a: bounded retries 30 s → 2 min → 8 min, expiry on every job, exhausted jobs to dead-letter.
const RETRY = { retryLimit: 3, retryDelay: 30, retryBackoff: true, retryDelayMax: 480, deadLetter: Q.deadLetter };

interface QueueDef<T> {
  name: QueueName;
  concurrency: number;
  expireInSeconds: number;
  schema: z.ZodType<T>;
  run: (d: Deps, data: T) => Promise<unknown>;
}

const queues: QueueDef<any>[] = [
  { name: Q.startBoardRun, concurrency: 1, expireInSeconds: 120, schema: StartBoardRun, run: startBoardRun },
  { name: Q.apifyRunEvent, concurrency: 1, expireInSeconds: 120, schema: ApifyRunEvent, run: onApifyRunEvent },
  { name: Q.fetchDataset, concurrency: 1, expireInSeconds: 300, schema: FetchDataset, run: fetchDataset },
  { name: Q.extractLlm, concurrency: 2, expireInSeconds: 180, schema: ExtractLlm, run: extractLlm },
  { name: Q.pollRuns, concurrency: 1, expireInSeconds: 120, schema: z.unknown(), run: (d) => pollRuns(d) },
  { name: Q.reconcileApify, concurrency: 1, expireInSeconds: 120, schema: z.unknown(), run: (d) => reconcileApify(d) },
];

async function main() {
  boss.on("error", (e) => log("pg-boss error", describe(e)));
  await boss.start();
  await boss.createQueue(Q.deadLetter, { retentionSeconds: 14 * 86400 }).catch(ignoreExists);

  for (const q of queues) {
    await boss.createQueue(q.name, { ...RETRY, expireInSeconds: q.expireInSeconds }).catch(ignoreExists);
    await boss.work(q.name, { localConcurrency: q.concurrency }, async ([job]) => {
      if (!job) return;
      const data = q.schema.parse(job.data);
      try {
        const result = await q.run(deps, data);
        log("job done", { queue: q.name, id: job.id, result });
        return result;
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          // §5.3: paid work pauses until the cap allows it; not a failure.
          await boss.send(q.name, job.data as object, { startAfter: 3600 });
          log("deferred: budget cap", { queue: q.name, key: e.key });
          return { deferred: true };
        }
        if (e instanceof ProviderError && !e.retryable) {
          // Bad input or invalid output after the client's own retry: fail now, don't retry (§5.3a).
          await boss.send(Q.deadLetter, { queue: q.name, data: job.data, error: e.message });
          log("job failed (not retryable)", { queue: q.name, id: job.id, error: e.message });
          return { failed: e.message };
        }
        log("job error (will retry)", { queue: q.name, id: job.id, retry: job.retryCount, ...describe(e) });
        throw e;
      }
    });
  }

  // One cron at a time (§5.3a): pg-boss schedules are singletons per queue.
  await boss.schedule(Q.pollRuns, "*/5 * * * *");
  await boss.schedule(Q.reconcileApify, "15 3 * * *");
  log("worker started", { queues: queues.map((q) => q.name) });
}

function ignoreExists(e: unknown) {
  if (!/already exists/i.test(String(e))) throw e;
}

// Clean restarts (§5.3a): stop taking jobs, let running ones finish, then exit.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("stopping", { signal });
  await boss.stop({ graceful: true, timeout: 30_000 });
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((e) => {
  log("worker failed to start", describe(e));
  process.exit(1);
});
