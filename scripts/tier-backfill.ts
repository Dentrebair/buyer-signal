// Fills challenges.urgency_tier for signals stored before migration 0010 (PRD §1.1). Free: the
// same fixed rules the worker uses, over the stored evidence. Safe to run twice.
// Usage: npm run tier:backfill            (rows with no tier)
//        npm run tier:backfill -- --all   (every row, after a rule change)
import { type VerticalSlug, matchAtoms, urgencyTier } from "@bs/core";
import { createPool } from "@bs/db";

const pool = createPool(1);
const rows = (
  await pool.query<{ id: string; source_type: string; author_relation: string | null; evidence_snippet: string; vertical: VerticalSlug | null }>(
    `select ch.id, ch.source_type, ch.author_relation, ch.evidence_snippet, c.vertical
       from challenges ch join companies c on c.id = ch.company_id where ch.urgency_tier is null or $1::boolean`,
    [process.argv.includes("--all")],
  )
).rows;
const counts = { high: 0, medium: 0, low: 0 };
for (const r of rows) {
  const title = r.source_type === "job_post" ? r.evidence_snippet.split("\n\n")[0] : null;
  const tier = urgencyTier({
    sourceType: r.source_type,
    authorRelation: r.author_relation,
    title,
    text: r.evidence_snippet,
    matches: matchAtoms(r.evidence_snippet, r.vertical),
  });
  await pool.query("update challenges set urgency_tier = $2 where id = $1", [r.id, tier]);
  counts[tier]++;
}
console.log(JSON.stringify({ updated: rows.length, ...counts }));
await pool.end();
