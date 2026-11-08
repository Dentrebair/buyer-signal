// One-off (migration 0026): pain types for challenges stored before they were recorded, from
// their evidence and their company's vertical, as the worker now does at insert.
// Usage: npm run backfill:pain-types
import { type VerticalSlug, matchAtoms, painTypesOf } from "@bs/core";
import { createPool } from "@bs/db";

const pool = createPool(1);
const rows = (
  await pool.query<{ id: string; source_type: string; evidence_snippet: string; vertical: VerticalSlug | null }>(
    "select ch.id, ch.source_type, ch.evidence_snippet, c.vertical from challenges ch join companies c on c.id = ch.company_id where ch.pain_types = '{}'",
  )
).rows;
let set = 0;
for (const r of rows) {
  const types = painTypesOf(r.source_type, matchAtoms(r.evidence_snippet, r.vertical).map((m) => m.category));
  if (!types.length) continue;
  await pool.query("update challenges set pain_types = $2 where id = $1", [r.id, types]);
  set++;
}
console.log(`${set} of ${rows.length} challenges given pain types`);
console.log((await pool.query("select unnest(pain_types) t, count(*)::int n from challenges group by 1 order by 2 desc")).rows);
await pool.end();
