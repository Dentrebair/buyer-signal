// Sender-only pg-boss client for the web app: enqueues, never works jobs or runs maintenance.
import { PgBoss } from "pg-boss";

const g = globalThis as unknown as { __bsBoss?: Promise<PgBoss> };

export function queue(): Promise<PgBoss> {
  g.__bsBoss ??= (async () => {
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      max: 1,
      application_name: "bs-web-boss",
      supervise: false,
      schedule: false,
      migrate: false, // the worker owns the pg-boss schema
    });
    boss.on("error", (e) => console.error("pg-boss (web)", e));
    await boss.start();
    return boss;
  })().catch((e) => {
    g.__bsBoss = undefined; // retry on the next request
    throw e;
  });
  return g.__bsBoss;
}
