// Leak check (migration 0022, §6.3 step 6): sampled trie drops, the AI's verdict on each, and the
// phrase proposals the operator decides.
import type pg from "pg";
import { type ApprovedAtoms, type AtomList, type LeakCheck, type VerticalSlug, maskContacts } from "@bs/core";
import type { Db } from "./pool.ts";

// Safe to run twice: one row per post.
export async function recordDropSample(c: pg.PoolClient | Db, x: { runId: string; naturalId: string; vertical: string | null; country: string; title: string; text: string }): Promise<void> {
  await c.query(
    `insert into drop_samples (run_id, natural_id, vertical, country, title, text) values ($1, $2, $3, $4, $5, $6)
     on conflict (natural_id) do nothing`,
    [x.runId, x.naturalId, x.vertical, x.country, maskContacts(x.title).slice(0, 300), maskContacts(x.text).slice(0, 8000)],
  );
}

// `idPrefix`: only samples whose post id starts with it (tests read their own rows only).
export async function pendingSamples(db: Db, limit: number, idPrefix = ""): Promise<{ id: string; title: string; text: string; vertical: string | null }[]> {
  return (
    await db.query(
      "select id, title, text, vertical from drop_samples where status = 'pending' and starts_with(natural_id, $2) order by created_at limit $1",
      [limit, idPrefix],
    )
  ).rows;
}

// The verdict, and for a lead each phrase merged into the proposals: a new phrase is proposed;
// a known one gains evidence; a rejected one comes back once its evidence doubles (§4.1c).
export async function saveLeakCheck(c: pg.PoolClient, sample: { id: string; vertical: string | null }, out: LeakCheck): Promise<number> {
  await c.query("update drop_samples set status = 'checked', is_lead = $2, reason = $3, phrases = $4, checked_at = now() where id = $1", [
    sample.id,
    out.is_lead,
    out.reason,
    JSON.stringify(out.phrases),
  ]);
  for (const p of out.phrases)
    await c.query(
      `insert into trie_proposals (phrase, category, vertical, examples) values ($1, $2, $3, array[$4::uuid])
       on conflict (lower(phrase), coalesce(vertical, '')) do update set
         evidence = trie_proposals.evidence + 1,
         examples = (trie_proposals.examples || array[$4::uuid])[1:10],
         status = case when trie_proposals.status = 'rejected' and trie_proposals.evidence + 1 >= 2 * coalesce(trie_proposals.evidence_at_decision, 1)
                       then 'proposed' else trie_proposals.status end`,
      [p.phrase, p.category, sample.vertical, sample.id],
    );
  return out.phrases.length;
}

export async function markSampleError(db: Db, id: string): Promise<void> {
  await db.query("update drop_samples set status = 'ai_error', checked_at = now() where id = $1 and status = 'pending'", [id]);
}

// Approved phrases as atom lists, per vertical (or core when the post had none), with a version
// that changes whenever the approved list does.
export async function approvedAtoms(db: Db): Promise<ApprovedAtoms> {
  const rows = (await db.query<{ phrase: string; category: keyof AtomList; vertical: VerticalSlug | null; decided_at: Date | null }>(
    "select phrase, category, vertical, decided_at from trie_proposals where status = 'approved' order by phrase",
  )).rows;
  const out: ApprovedAtoms = { version: `${rows.length}:${Math.max(0, ...rows.map((r) => r.decided_at?.getTime() ?? 0))}`, core: {}, vertical: {} };
  for (const r of rows) {
    const list = r.vertical ? (out.vertical[r.vertical] ??= {}) : out.core;
    (list[r.category] ??= []).push(r.phrase);
  }
  return out;
}

export async function purgeDropSamples(db: Db, days: number): Promise<number> {
  return (await db.query("delete from drop_samples where created_at < now() - make_interval(days => $1)", [days])).rowCount ?? 0;
}
