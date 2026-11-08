// Worker: runs every pipeline step on pg-boss (PRD §3, §5.2, §5.3a).
// Usage: npm run worker
import { PgBoss } from "pg-boss";
import { z } from "zod";
import { type QueueName, ApifyRunEvent, CardLiComment, CardLiPost, ExtractLlm, FetchDataset, FetchLiRun, Q, ReadLiPost, SniffDomain, StartBoardRun, StartLiRun } from "@bs/core";
import { BudgetExceededError, createPool, gatedLlm } from "@bs/db";
import { ApifyClient, OpenRouterClient, ProviderError, RdapClient, fetchPage, loadFingerprints, sniffWebsite } from "@bs/integrations";
import { type Deps, cardLiComment, cardLiPost, driftCheck, extractLlm, fetchDataset, fetchLiRun, ingestRotation, readLiPost, startLiRun, onApifyRunEvent, syncSearchArms, pollRuns, reconcileApify, resolveBatch, sniffDomain, sniffSeeds, startBoardRun } from "./jobs.ts";

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    APIFY_CYCLE_CAP_USD: z.coerce.number().positive().default(4.5),
    MONTHLY_CAP_USD: z.coerce.number().positive().default(20),
    SEARCH_DAILY_CAP: z.coerce.number().int().min(0).default(15),
    ROTATION_ENABLED: z.enum(["true", "false"]).default("false"),
    BOARD_SLOTS_PER_DAY: z.coerce.number().int().min(0).max(45).default(3),
    BOARD_POSTS_PER_SLOT: z.coerce.number().int().min(1).max(100).default(35),
    SOCIAL_SLOTS_PER_DAY: z.coerce.number().int().min(0).max(5).default(1), // LinkedIn post searches a day
    LI_POSTS_PER_TOPIC: z.coerce.number().int().min(1).max(50).default(5),
    LI_COMMENTS_PER_POST: z.coerce.number().int().min(0).max(20).default(5),
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
  fetchPage: (url) => fetchPage(url),
  rdap: new RdapClient(),
  sniff: (x) => sniffWebsite(x),
  send: (queue, data, opts, tx) =>
    boss.send(queue, data, { ...opts, ...(tx ? { db: { executeSql: (text: string, values?: unknown[]) => tx.query(text, values) } } : {}) }),
  settings: {
    apifyCycleCapUsd: env.APIFY_CYCLE_CAP_USD,
    searchDailyCap: env.SEARCH_DAILY_CAP,
    rotationEnabled: env.ROTATION_ENABLED === "true",
    boardSlotsPerDay: env.BOARD_SLOTS_PER_DAY,
    boardPostsPerSlot: env.BOARD_POSTS_PER_SLOT,
    socialSlotsPerDay: env.SOCIAL_SLOTS_PER_DAY,
    liPostsPerTopic: env.LI_POSTS_PER_TOPIC,
    liCommentsPerPost: env.LI_COMMENTS_PER_POST,
  },
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
  run: (d: Deps, data: T, jobId: string) => Promise<unknown>;
}

const queues: QueueDef<any>[] = [
  { name: Q.startBoardRun, concurrency: 1, expireInSeconds: 120, schema: StartBoardRun, run: startBoardRun },
  { name: Q.apifyRunEvent, concurrency: 1, expireInSeconds: 120, schema: ApifyRunEvent, run: onApifyRunEvent },
  { name: Q.fetchDataset, concurrency: 1, expireInSeconds: 300, schema: FetchDataset, run: fetchDataset },
  { name: Q.extractLlm, concurrency: 2, expireInSeconds: 180, schema: ExtractLlm, run: extractLlm },
  // LinkedIn post search (§4.1d): Run now and the rotation's social slot; completion through poll-runs.
  { name: Q.startLiRun, concurrency: 1, expireInSeconds: 120, schema: StartLiRun, run: startLiRun },
  { name: Q.fetchLiRun, concurrency: 1, expireInSeconds: 300, schema: FetchLiRun, run: fetchLiRun },
  { name: Q.readLiPost, concurrency: 2, expireInSeconds: 180, schema: ReadLiPost, run: readLiPost },
  { name: Q.cardLiPost, concurrency: 2, expireInSeconds: 180, schema: CardLiPost, run: cardLiPost },
  { name: Q.cardLiComment, concurrency: 2, expireInSeconds: 180, schema: CardLiComment, run: cardLiComment },
  // One batch a day, so the day's best-scoring posts get the search quota (§5.1 step 5c).
  { name: Q.resolveBatch, concurrency: 1, expireInSeconds: 900, schema: z.unknown(), run: (d) => resolveBatch(d) },
  // Free (plain HTTP) and automatic (§4.2): pending seeds every 10 min, 4 sites at a time.
  { name: Q.sniffSeeds, concurrency: 1, expireInSeconds: 120, schema: z.unknown(), run: (d) => sniffSeeds(d) },
  { name: Q.sniffDomain, concurrency: 4, expireInSeconds: 120, schema: SniffDomain, run: sniffDomain },
  // Daily, paid (Apify); does nothing unless ROTATION_ENABLED=true (§4.1).
  { name: Q.ingestRotation, concurrency: 1, expireInSeconds: 120, schema: z.unknown(), run: (d) => ingestRotation(d) },
  { name: Q.pollRuns, concurrency: 1, expireInSeconds: 120, schema: z.unknown(), run: (d) => pollRuns(d) },
  { name: Q.reconcileApify, concurrency: 1, expireInSeconds: 120, schema: z.unknown(), run: (d) => reconcileApify(d) },
  // Free (SQL only): has the AI or a search drifted? Results on the inbox and Sources pages.
  { name: Q.driftCheck, concurrency: 1, expireInSeconds: 120, schema: z.unknown(), run: (d) => driftCheck(d) },
];

async function main() {
  loadFingerprints(); // fail at start, not on the first sniff, if the data file is missing
  boss.on("error", (e) => log("pg-boss error", describe(e)));
  await boss.start();
  await boss.createQueue(Q.deadLetter, { retentionSeconds: 14 * 86400 }).catch(ignoreExists);

  for (const q of queues) {
    await boss.createQueue(q.name, { ...RETRY, expireInSeconds: q.expireInSeconds }).catch(ignoreExists);
    await boss.work(q.name, { localConcurrency: q.concurrency }, async ([job]) => {
      if (!job) return;
      try {
        const result = await q.run(deps, q.schema.parse(job.data), job.id);
        log("job done", { queue: q.name, id: job.id, result });
        return result;
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          // §5.3: paid work pauses until the cap allows it; not a failure.
          await boss.send(q.name, job.data as object, { startAfter: 3600 });
          log("deferred: budget cap", { queue: q.name, key: e.key });
          return { deferred: true };
        }
        if ((e instanceof ProviderError && !e.retryable) || e instanceof z.ZodError) {
          // Bad input (invalid payload, 4xx) or invalid output after the client's own retry:
          // fail now, don't retry (§5.3a).
          const error = e instanceof z.ZodError ? `invalid payload: ${z.prettifyError(e)}` : e.message;
          await boss.send(Q.deadLetter, { queue: q.name, data: job.data, error });
          log("job failed (not retryable)", { queue: q.name, id: job.id, error });
          return { failed: error };
        }
        log("job error (will retry)", { queue: q.name, id: job.id, retry: job.retryCount, ...describe(e) });
        throw e;
      }
    });
  }

  // One cron at a time (§5.3a): pg-boss schedules are singletons per queue.
  await boss.schedule(Q.pollRuns, "*/5 * * * *");
  await boss.schedule(Q.reconcileApify, "15 3 * * *");
  await boss.schedule(Q.resolveBatch, "0 4 * * *");
  await boss.schedule(Q.driftCheck, "30 5 * * *"); // after the night's runs and resolves
  await boss.schedule(Q.sniffSeeds, "*/10 * * * *");
  // Daily rotation: off for now; runs are started by hand (Run now). To enable, uncomment and
  // set ROTATION_ENABLED=true. 02:00 is before the 04:00 resolve batch, so the day's new posts
  // get the search quota (§5.1 step 5c).
  // await boss.schedule(Q.ingestRotation, "0 2 * * *");
  await boss.unschedule(Q.ingestRotation).catch(() => {}); // drop the schedule an earlier start registered
  // Search arms (§4.1c): the code's searches, links for runs from before the bandit, retirements.
  log("search arms synced", await syncSearchArms(deps));
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
