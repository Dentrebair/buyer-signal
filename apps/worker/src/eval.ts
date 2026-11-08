// AI test set (agreed 2026-11-08): re-reads every post the operator labelled with today's prompt
// and model, scores the AI against the labels and stores the run (Sources page, Health).
// Usage: npm run eval            (≈ $0.0004 a post, inside the monthly AI cap)
//        npm run eval -- --dry   (counts the cases and the cost, calls nothing)
import { createHash } from "node:crypto";
import { type EvalPrediction, buildLiRead, liCardGate, scoreEval } from "@bs/core";
import { createPool, evalCases, gatedLlm, saveEvalRun } from "@bs/db";
import { OpenRouterClient } from "@bs/integrations";

const PARALLEL = 4;
const PER_POST_USD = 0.0004; // measured 2026-11-08

const pct = (x: number | null) => (x === null ? "  —" : `${Math.round(x * 100)}%`.padStart(4));

async function main() {
  const pool = createPool(2);
  try {
    const cases = await evalCases(pool);
    const labels = { lead: 0, pain: 0, none: 0 };
    for (const c of cases) labels[c.label]++;
    console.log(`${cases.length} labelled posts: ${labels.lead} leads, ${labels.pain} pain but not a lead, ${labels.none} no pain. About $${(cases.length * PER_POST_USD).toFixed(3)}.`);
    if (process.argv.includes("--dry") || cases.length === 0) {
      if (!cases.length) console.log("Nothing to score: label posts on /linkedin (Posts tab) first.");
      return;
    }
    const llm = gatedLlm(pool, new OpenRouterClient(), { monthlyCapUsd: Number(process.env.MONTHLY_CAP_USD ?? 20) });
    const predictions: EvalPrediction[] = [];
    let cost = 0;
    let model = "";
    let system = "";
    const queue = [...cases];
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          // Post-level labels, so the read sees the post alone, as a post with no comments.
          const req = buildLiRead({ text: c.text, authorHeadline: c.headline, authorType: c.authorType }, []);
          system = req.system;
          try {
            const out = await llm.json("extraction", req);
            cost += out.costUsd;
            model = out.model;
            const gate = liCardGate(out.data);
            predictions.push({ id: c.id, pain: out.data.has_pain, lead: gate.ok, why: gate.ok ? "card" : gate.outcome });
          } catch (e) {
            console.log(`  could not read case ${c.id.slice(0, 8)}: ${(e as Error).message}`);
          }
        }
      }),
    );
    const score = scoreEval(cases, predictions);
    const promptHash = createHash("sha256").update(system).digest("hex").slice(0, 12);
    await saveEvalRun(pool, { model, promptHash, cases: score.cases, score, costUsd: cost });

    console.log(`\nModel ${model}, prompt ${promptHash}, ${score.cases} of ${cases.length} scored, $${cost.toFixed(4)}`);
    console.log("            precision  recall");
    console.log(`  Pain        ${pct(score.pain.precision)}     ${pct(score.pain.recall)}`);
    console.log(`  Lead        ${pct(score.lead.precision)}     ${pct(score.lead.recall)}`);
    console.log(`  Agreement   ${pct(score.agreement)}`);
    const text = new Map(cases.map((c) => [c.id, c.text]));
    for (const d of score.disagreements)
      console.log(`\n  You: ${d.label}. AI: ${d.lead ? "lead" : d.pain ? "pain" : "none"} (${d.why})\n    “${text.get(d.id)!.replace(/\s+/g, " ").slice(0, 160)}…”`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
