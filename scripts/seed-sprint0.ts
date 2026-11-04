// Loads the Sprint 0 job posts (data/sprint0/) through the real pipeline rules into the database
// as sample companies (PRD §15 Sprint 1 item 4). Usage: npm run db:seed [-- --limit N]
//
// Extraction results are cached in data/sprint0/extractions.json, so a re-run costs nothing.
// The posts are older than 21 days and undated, so the freshness rule is skipped and every
// company is flagged is_sample (removed by `npm run db:unseed`).
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  type SeedExtraction,
  bareDomain,
  blastRadius,
  buildSeedExtraction,
  classifySize,
  signalScore,
  weightsFor,
} from "@bs/core";
import { createPool, gatedLlm, insertChallenge, recomputeCompanyScore, upsertCompany, withTransaction } from "@bs/db";
import { OpenRouterClient } from "@bs/integrations";

const DIR = new URL("../data/sprint0/", import.meta.url);
const CACHE = new URL("extractions.json", DIR);

interface Post {
  board: string;
  url: string;
  title: string;
  company: string | null;
  description: string;
  board_size: string | null;
  board_website: string | null;
  label: { recruiter_or_staffing: boolean; desk_role: boolean } | null;
}
interface Resolved {
  company: string | null;
  city: string | null;
  board_domain: string | null;
  resolved_domain: string | null;
}
interface Cached {
  data: SeedExtraction;
  model: string;
  costUsd: number;
}

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;

async function main() {
  const posts: Post[] = JSON.parse(await readFile(new URL("posts_labelled.json", DIR), "utf8"));
  const resolved: Resolved[] = JSON.parse(await readFile(new URL("companies_resolved.json", DIR), "utf8"));
  const cache: Record<string, Cached> = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, "utf8")) : {};

  const byName = new Map<string, Resolved>();
  for (const r of resolved) if (r.company) byName.set(r.company.trim().toLowerCase(), r);

  const counts = { candidates: 0, recruiter_or_physical: 0, no_domain: 0, no_description: 0, no_fit: 0, size: 0, failed: 0, loaded: 0, duplicate: 0 };
  const candidates: { post: Post; domain: string; city: string | null }[] = [];
  for (const post of posts) {
    // Stand-in for the trie gate until Sprint 2: the Sprint 0 labels (recruiter, desk role).
    if (!post.label || post.label.recruiter_or_staffing || !post.label.desk_role) {
      counts.recruiter_or_physical++;
      continue;
    }
    const r = post.company ? byName.get(post.company.trim().toLowerCase()) : undefined;
    const domain = bareDomain(post.board_website) ?? bareDomain(r?.board_domain) ?? bareDomain(r?.resolved_domain);
    if (!domain) {
      counts.no_domain++;
      continue;
    }
    if ((post.description ?? "").length < 200) {
      counts.no_description++;
      continue;
    }
    candidates.push({ post, domain, city: r?.city ?? null });
  }
  counts.candidates = candidates.length;
  const todo = candidates.slice(0, limit);

  const pool = createPool(3);
  const llm = gatedLlm(pool, new OpenRouterClient({ retryDelaysMs: [2_000, 8_000, 30_000] }), {
    monthlyCapUsd: Number(process.env.MONTHLY_CAP_USD ?? 20),
  });
  let spent = 0;

  try {
    // Four LLM calls at a time; each post commits in its own transaction (§5.3a small units).
    const queue = [...todo];
    const workers = Array.from({ length: 4 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const { post, domain, city } = item;
        try {
          let hit = cache[post.url];
          if (!hit) {
            const req = buildSeedExtraction({ title: post.title, company: post.company, location: city, description: post.description });
            const out = await llm.json("extraction", req);
            hit = { data: out.data, model: out.model, costUsd: out.costUsd };
            cache[post.url] = hit;
            spent += out.costUsd;
          }
          const si = hit.data;
          if (si.automation_fit === "none") {
            counts.no_fit++;
            continue;
          }
          const size = classifySize({ employeeBand: post.board_size, bandSource: "job_board", knownLargeBrand: si.known_large_brand, now: new Date() });
          if (!size.keep) {
            counts.size++;
            continue;
          }
          const w = weightsFor("job_post");
          const B = blastRadius(si.blast_radius);
          const { vertical, ...structured } = si;
          const inserted = await withTransaction(pool, async (c) => {
            const companyId = await upsertCompany(c, {
              domain,
              companyName: post.company,
              vertical,
              country: post.board.split("_").at(-1) ?? null,
              employeeBand: post.board_size,
              sizeTier: size.tier,
              sizeSource: size.source,
              isSample: true,
            });
            const ok = await insertChallenge(c, {
              companyId,
              sourceType: "job_post",
              naturalId: `sample:${post.url}`,
              sourceUrl: post.url,
              E: w.E,
              I: w.I,
              B,
              signalScore: signalScore("job_post", w, B),
              department: si.department,
              postedAt: null,
              evidenceSnippet: `${post.title}\n\n${post.description}`,
              structuredIntelligence: structured,
              llmModel: hit.model,
            });
            if (ok) await recomputeCompanyScore(c, companyId);
            return ok;
          });
          if (inserted) counts.loaded++;
          else counts.duplicate++;
        } catch (e) {
          counts.failed++;
          console.error(`failed ${post.url}: ${(e as Error).message}`);
        }
      }
    });
    await Promise.all(workers);
  } finally {
    await writeFile(CACHE, JSON.stringify(cache, null, 1));
    await pool.end();
  }

  console.log(JSON.stringify(counts));
  console.log(`OpenRouter spend this run: $${spent.toFixed(4)}`);
  if (counts.failed) process.exit(1);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
