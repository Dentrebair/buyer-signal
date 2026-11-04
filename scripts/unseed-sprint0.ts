// Removes every sample company loaded by seed-sprint0.ts (challenges cascade).
// Usage: npm run db:unseed
import { createPool } from "@bs/db";

const pool = createPool(1);
try {
  const r = await pool.query("delete from companies where is_sample");
  console.log(`deleted ${r.rowCount} sample companies`);
} finally {
  await pool.end();
}
