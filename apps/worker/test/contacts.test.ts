// Contact search against the real database with a fake AI (no spend). The fake embedder hands back
// a stored statement's own vector, so the nearest-pain SQL must find that statement's person first.
// Skipped without DATABASE_URL, without an embedded LinkedIn statement, or with statements waiting
// to be embedded. The search row is removed.
import { afterAll, describe, expect, it } from "vitest";
import type { LlmClient } from "@bs/core";
import { collectPainStatements, createPool, statementsToEmbed } from "@bs/db";
import { contactSearchJob } from "../src/jobs.ts";

const url = process.env.DATABASE_URL;
const pool = url ? createPool(2) : null;
afterAll(async () => {
  await pool?.query("delete from contact_searches where query like 'test: contact search%'");
  await pool?.end();
});

describe.skipIf(!url)("contact-search", () => {
  it("plans, finds the person behind the nearest pain, ranks, and saves", async () => {
    const seed = (
      await pool!.query<{ embedding: string; author: string | null }>(
        `select s.embedding::text embedding, p.author_name author from pain_statements s join li_posts p on p.id = s.source_id::uuid
          where s.source = 'li_post' and s.embedding is not null and p.author_name is not null limit 1`,
      )
    ).rows[0];
    if (!seed) return; // nothing embedded yet on this database
    // The job embeds statements read since the last trends run: with the fake embedder that would
    // store fake vectors on real rows, so the test runs only when nothing is waiting.
    await collectPainStatements(pool!);
    if ((await statementsToEmbed(pool!, 1)).length) return;
    const vec = JSON.parse(seed.embedding) as number[];
    const ranked: string[] = [];
    const llm: LlmClient = {
      worstCaseUsd: async () => 0.001,
      json: async (_task, req) => {
        if (req.schemaName === "contact_plan") return { data: req.parse({ seeking: "buyers", icp: "Owners", pains: ["the seeded pain"], terms: [] }) as any, model: "fake/plan", costUsd: 0.001 };
        ranked.push(req.user);
        const ids = [...req.user.matchAll(/<contact id="(\d+)"/g)].map((m) => Number(m[1]));
        return { data: req.parse({ contacts: ids.map((id) => ({ id, match: 90 - id, why: "fits", points: ["a point"] })) }) as any, model: "fake/rank", costUsd: 0.002 };
      },
    };
    const id = (await pool!.query<{ id: string }>("insert into contact_searches (query) values ('test: contact search for owners') returning id")).rows[0]!.id;
    const d = { pool: pool!, llm, embedder: { embed: async (t: string[]) => ({ vectors: t.map(() => vec), model: "fake/embed", costUsd: 0 }) }, log: () => {} };
    const msg = await contactSearchJob(d, { searchId: id });
    expect(msg).toMatch(/people matched/);
    const row = (await pool!.query("select status, results, candidates, model, cost_usd::float8 cost from contact_searches where id = $1", [id])).rows[0];
    expect(row).toMatchObject({ status: "done", model: "fake/rank", cost: 0.003 });
    expect(row.results[0]).toMatchObject({ name: seed.author, match: 90, points: ["a point"] });
    expect(row.results[0].profileUrl ?? "https://").toMatch(/^https:\/\/[^?]+$/);
    expect(ranked[0]).toContain("<request>test: contact search for owners</request>");
    // A second run of the same job does nothing.
    expect(await contactSearchJob(d, { searchId: id })).toBe("already done");
  });
});
