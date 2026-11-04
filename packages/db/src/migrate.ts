// Applies packages/db/migrations/*.sql in name order, each in its own transaction.
// Usage: npm run db:migrate
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPool } from "./pool.ts";

const dir = fileURLToPath(new URL("../migrations/", import.meta.url));

async function main() {
  const pool = createPool(1);
  try {
    await pool.query(`create table if not exists schema_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    await pool.query("alter table schema_migrations enable row level security");
    const applied = new Map(
      (await pool.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations")).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const name of files) {
      const sql = await readFile(dir + name, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prev = applied.get(name);
      if (prev) {
        if (prev !== checksum) throw new Error(`${name} changed after it was applied — add a new migration instead`);
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [name, checksum]);
        await client.query("commit");
        console.log(`applied ${name}`);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`${name} failed: ${(e as Error).message}`);
      } finally {
        client.release();
      }
    }
    console.log(`up to date (${files.length} migration${files.length === 1 ? "" : "s"})`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
