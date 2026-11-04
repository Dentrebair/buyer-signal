// Queues one Indeed run for the worker (Sprint 1 item 8). The worker must be running.
// Usage: npm run ingest:once -- --country us --title "accounts payable clerk" --limit 10 [--vertical accounting] [--location "Dallas"]
import { parseArgs } from "node:util";
import { PgBoss } from "pg-boss";
import { Q, StartBoardRun } from "@bs/core";

const { values } = parseArgs({
  options: {
    country: { type: "string" },
    title: { type: "string" },
    limit: { type: "string", default: "10" },
    vertical: { type: "string" },
    location: { type: "string" },
  },
});

const job = StartBoardRun.parse({
  country: values.country,
  title: values.title,
  limit: Number(values.limit),
  vertical: values.vertical ?? null,
  ...(values.location ? { location: values.location } : {}),
});

const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, max: 1, supervise: false, schedule: false, migrate: false });
await boss.start();
const id = await boss.send(Q.startBoardRun, job);
console.log(`queued ${Q.startBoardRun} ${id}: ${job.limit} × "${job.title}" in ${job.country}`);
await boss.stop({ graceful: false });
