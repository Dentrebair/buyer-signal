// Keyword mining (PRD §6.3), offline: these posts never enter the lead pipeline.
// Usage: npm run mine -- <step> [--vertical accounting] [--per-title 12]
//   fetch  Indeed posts per vertical × market × search title (Apify, ~$0.002 per 12 posts)
//   label  LLM labels + candidate phrases for every post (OpenRouter, ~$0.0002 per post)
//   build  validated phrases → packages/core/src/atoms.ts
//   eval   gate recall on the held-out posts, per vertical
//   review local page for the operator to check eval labels; apply <file> writes the answers back
// Data lives in data/mining/ (git-ignored). Every step is safe to re-run; done work is skipped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  type Country,
  MINED_CATEGORIES,
  type MinedCategory,
  PostLabel,
  SEED_ATOMS,
  SCOPE_LABEL,
  atomText,
  buildJobExtraction,
  compileAtoms,
  findAtoms,
  gateJobPost,
  isPositive,
  recallReport,
  scopeOf,
  words,
  SEARCH_TITLES,
  VERTICAL_MARKETS,
  type VerticalSlug,
  VerticalSlug as VerticalEnum,
  apifyCycleKey,
  apifyChargeCap,
  holdOut,
  scrubPersonal,
  worstCaseApifyCost,
} from "@bs/core";
import { createPool, gatedLlm, reserveApifyRun, seedApifyCycle, settleSpend } from "@bs/db";
import { ApifyClient, INDEED_ACTOR, INDEED_PRICES, OpenRouterClient, TERMINAL, indeedInput, mapIndeedItem, runCostUsd } from "@bs/integrations";

const DIR = "data/mining";
const POSTS = `${DIR}/posts.json`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { vertical: { type: "string" }, "per-title": { type: "string", default: "12" }, titles: { type: "string", default: "2" } },
});
const only = values.vertical ? VerticalEnum.parse(values.vertical) : null;

export interface MinePost {
  id: string;
  vertical: VerticalSlug;
  country: Country;
  query: string;
  title: string;
  company: string | null;
  description: string;
  url: string;
}
interface PostsFile {
  posts: MinePost[];
  fetched: string[]; // vertical|country|title|batch
  apifyUsd: number;
}

function load<T>(path: string, empty: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : empty;
}
function save(path: string, data: unknown) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 1));
}

// ── fetch ──────────────────────────────────────────────────────────────────
// Each market of a vertical uses a different pair of its titles, so all titles get tried.
// --vertical x fetches one more batch for that vertical only (§6.3 step 5).
async function fetchPosts() {
  const file = load<PostsFile>(POSTS, { posts: [], fetched: [], apifyUsd: 0 });
  const perTitle = Number(values["per-title"]);
  const batch = only ? Math.max(0, ...file.fetched.filter((k) => k.startsWith(`${only}|`)).map((k) => Number(k.split("|")[3]))) + 1 : 1;
  const slots: { vertical: VerticalSlug; country: Country; title: string; key: string }[] = [];
  for (const vertical of Object.keys(SEARCH_TITLES) as VerticalSlug[]) {
    if (only && vertical !== only) continue;
    const titles = SEARCH_TITLES[vertical];
    VERTICAL_MARKETS[vertical].forEach((country, i) => {
      for (let t = 0; t < Number(values.titles); t++) {
        const title = titles[(i + t + (batch - 1)) % titles.length]!;
        const key = `${vertical}|${country}|${title}|${batch}`;
        if (!file.fetched.includes(key)) slots.push({ vertical, country, title, key });
      }
    });
  }
  console.log(`${slots.length} runs × ${perTitle} posts (batch ${batch})`);

  const apify = new ApifyClient();
  const pool = createPool(2);
  const cap = Number(process.env.APIFY_CYCLE_CAP_USD ?? 4.5);
  const plan = { maxItems: perTitle, pricePerItem: INDEED_PRICES["apify-default-dataset-item"], startPrice: INDEED_PRICES["apify-actor-start"] };
  const worst = worstCaseApifyCost(plan);
  const seen = new Set(file.posts.map((p) => p.id));

  const runOne = async (s: (typeof slots)[number]) => {
    const usage = await apify.usage();
    await seedApifyCycle(pool, usage.cycleStart, usage.usageUsd, cap);
    if (!(await reserveApifyRun(pool, usage.cycleStart, worst, cap))) throw new Error("Apify cycle cap reached");
    let run = await apify.startRun(INDEED_ACTOR, indeedInput({ country: s.country, title: s.title, limit: perTitle, datePosted: "14" }), {
      maxItems: perTitle,
      maxTotalChargeUsd: apifyChargeCap(plan),
    });
    while (!TERMINAL.includes(run.status)) {
      await new Promise((r) => setTimeout(r, 5000));
      run = await apify.getRun(run.id);
    }
    const items = run.status === "SUCCEEDED" ? await apify.datasetItems(run.defaultDatasetId, 0, perTitle) : [];
    // Right after a run ends, chargedEventCounts can still show only the start event.
    const cost = Math.max(runCostUsd(run, INDEED_PRICES), items.length * plan.pricePerItem + plan.startPrice);
    await settleSpend(pool, apifyCycleKey(usage.cycleStart), worst, { provider: "apify", units: 1, costUsd: cost, ref: `mining:${run.id}` });
    file.apifyUsd += cost;
    let added = 0;
    for (const raw of items) {
      const p = mapIndeedItem(raw, s.country);
      if (!p || seen.has(p.naturalId)) continue;
      seen.add(p.naturalId);
      file.posts.push({
        id: p.naturalId,
        vertical: s.vertical,
        country: s.country,
        query: s.title,
        title: p.title,
        company: p.company,
        description: scrubPersonal(p.description),
        url: p.url,
      });
      added++;
    }
    file.fetched.push(s.key);
    save(POSTS, file);
    console.log(`${s.key.padEnd(60)} ${run.status} ${items.length} items, ${added} new, $${cost.toFixed(4)}`);
  };

  const queue = [...slots];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) await runOne(s);
    }),
  );
  await pool.end();
  console.log(`posts: ${file.posts.length}, Apify spend so far: $${file.apifyUsd.toFixed(4)}`);
}

// ── label ──────────────────────────────────────────────────────────────────
// One LLM call per 5 posts. Mining posts give candidate phrases and per-phrase positive/negative
// counts; evaluation posts get the same labels as a pre-label for the operator to review
// (§6.3 step 3) — their phrases are never used to build the atoms.
const LABELS = `${DIR}/labels.json`;
const HOLDOUT = 20;
const BATCH = 5;
const MAX_CHARS = 5000;

export interface LabelledPost extends PostLabel {
  role: "mine" | "eval";
  vertical: VerticalSlug | null; // null = Sprint 0 post, pooled into the shared core list only
  reviewed?: boolean; // operator checked the eval label
}

const SYSTEM = `You label job posts for a tool that finds small businesses whose staff do repetitive desk work that software or AI could take over.

For each post return:
- desk_role: true if the job is mainly done at a desk, computer or phone. False for driving, warehouse, field work, trades, hands-on clinical care, teaching, or in-store and field sales.
- recruiter: true if a recruiter, staffing or placement agency posted it for a client, not the employer itself.
- automatable: how much of the described work is repetitive admin that software or AI could take over (data entry, invoices, reconciliation, documents, scheduling, follow-ups, reports, copying between systems, answering routine questions): "none", "some" or "high".
- reason: one short sentence.
- phrases: up to 12 short phrases (2-6 words) copied EXACTLY, word for word, from the post's title or text that show the above. Prefer duty phrases other posts would also use ("prepare invoices", "data entry in Tally") over company-specific ones. Categories:
  AUTOMATABLE_TASK: a repetitive task (data entry, invoicing, reconciliation, scheduling, follow-ups, reports)
  MANUAL_ROLE: a job title that exists to do such work ("data entry operator", "billing executive")
  INTEGRATION_DEBT: copying between systems or tools, spreadsheets used as glue
  DOCUMENT_FRICTION: paper, scanning, filing, forms, PDFs, collecting documents
  INFORMATION_SILO: SOPs, documenting procedures, organising shared drives, training material, knowledge base
  OWNER_DEPENDENCY: staff relying on the owner or founder for answers
  PHYSICAL_ROLE: shows the job is mainly physical, field or clinical ("lift up to 50 lbs", "field visits")
  RECRUITER: shows a recruiter or staffing agency posted it ("on behalf of our client")
  For each phrase give up to 4 variants: other wordings real job posts use for the same thing (synonyms, Indian, UAE or US terms, abbreviations). Variants need not appear in this post.
Return one entry per post, using the post's id.`;

const LabelBatch = z.object({ posts: z.array(PostLabel) });
const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["posts"],
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "desk_role", "recruiter", "automatable", "reason", "phrases"],
        properties: {
          id: { type: "string" },
          desk_role: { type: "boolean" },
          recruiter: { type: "boolean" },
          automatable: { type: "string", enum: ["none", "some", "high"] },
          reason: { type: "string" },
          phrases: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "category", "variants"],
              properties: {
                text: { type: "string" },
                category: { type: "string", enum: [...MINED_CATEGORIES] },
                variants: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
};

interface Sprint0Post {
  board: string;
  url: string;
  title: string;
  company: string | null;
  description: string;
}

// Mining posts, eval posts and the Sprint 0 posts (mining only), with their role.
function corpus(): { post: Pick<MinePost, "id" | "title" | "description">; role: "mine" | "eval"; vertical: VerticalSlug | null }[] {
  const { posts } = load<PostsFile>(POSTS, { posts: [], fetched: [], apifyUsd: 0 });
  const evalIds = holdOut(posts, HOLDOUT);
  const sprint0 = load<Sprint0Post[]>("data/sprint0/posts_labelled.json", []).filter((p) => p.description.length >= 100);
  return [
    ...posts.map((p) => ({ post: p, role: evalIds.has(p.id) ? ("eval" as const) : ("mine" as const), vertical: p.vertical })),
    ...sprint0.map((p) => ({ post: { id: `s0:${p.url}`, title: p.title, description: p.description }, role: "mine" as const, vertical: null })),
  ];
}

async function labelPosts() {
  const labels = load<Record<string, LabelledPost>>(LABELS, {});
  const todo = corpus().filter((c) => !labels[c.post.id] && (!only || c.vertical === only));
  console.log(`${todo.length} posts to label`);
  const pool = createPool(2);
  const llm = gatedLlm(pool, new OpenRouterClient({ maxTokens: 6000 }), { monthlyCapUsd: Number(process.env.MONTHLY_CAP_USD ?? 20) });
  let cost = 0;
  const batches: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  const work = async (b: (typeof todo)[number][]) => {
    const user = b
      .map((c) => `<post id="${c.post.id}">\n<title>${c.post.title}</title>\n<text>${c.post.description.slice(0, MAX_CHARS)}</text>\n</post>`)
      .join("\n\n");
    const res = await llm.json("extraction", { system: SYSTEM, user, schemaName: "post_labels", jsonSchema: LABEL_SCHEMA, parse: (r) => LabelBatch.parse(r) });
    cost += res.costUsd;
    for (const l of res.data.posts) {
      const c = b.find((x) => x.post.id === l.id);
      if (c) labels[l.id] = { ...l, role: c.role, vertical: c.vertical };
    }
    save(LABELS, labels);
  };
  const queue = [...batches];
  let done = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        try {
          await work(b);
        } catch (e) {
          console.log(`batch failed (re-run to retry): ${(e as Error).message.slice(0, 200)}`);
        }
        if (++done % 10 === 0) console.log(`${done}/${batches.length} batches, $${cost.toFixed(4)}`);
      }
    }),
  );
  await pool.end();
  console.log(`labelled ${Object.keys(labels).length} posts; this run $${cost.toFixed(4)}`);
}

// ── build ──────────────────────────────────────────────────────────────────
// A candidate is a phrase the LLM copied from a mining post (checked: it must really be in that
// post) or one of its variants (kept only if some mining post contains it, §6.3 step 2). Then
// every candidate is counted across all mining posts:
//   work atoms: in ≥ 1 positive post and ≥ 70 % of the posts it occurs in are positive
//   RECRUITER: in ≥ 2 recruiter posts and in no employer post (a wrong one costs recall)
//   PHYSICAL_ROLE: in a non-desk post's title and in no desk post's title
// An atom seen in positive posts of ≥ 3 verticals (the Sprint 0 pool counts as one) goes in the
// shared core list; otherwise in the lists of the verticals it was seen in.
const ATOMS_FILE = "packages/core/src/atoms.ts";
const MIN_SHARE = 0.7;
const CORE_VERTICALS = 3;

async function buildAtoms() {
  const labels = load<Record<string, LabelledPost>>(LABELS, {});
  const text = new Map(corpus().map((c) => [c.post.id, { title: c.post.title, all: `${c.post.title}\n${c.post.description}` }]));
  const mining = Object.entries(labels).filter(([id, l]) => l.role === "mine" && text.has(id));

  const votes = new Map<string, Map<MinedCategory, number>>();
  const vote = (atom: string, cat: MinedCategory) => {
    const m = votes.get(atom) ?? new Map<MinedCategory, number>();
    m.set(cat, (m.get(cat) ?? 0) + 1);
    votes.set(atom, m);
  };
  const variants: { atom: string; cat: MinedCategory }[] = [];
  let copied = 0;
  let paraphrased = 0;
  for (const [id, l] of mining) {
    for (const p of l.phrases) {
      const atom = atomText(p.text);
      const n = words(atom).length;
      if (n === 0 || n > 6) continue;
      if (findAtoms(compileAtoms({ [p.category]: [atom] }), text.get(id)!.all).size) {
        vote(atom, p.category);
        copied++;
      } else paraphrased++;
      for (const v of p.variants) {
        const va = atomText(v);
        if (words(va).length > 0 && words(va).length <= 6) variants.push({ atom: va, cat: p.category });
      }
    }
  }
  for (const v of variants) vote(v.atom, v.cat); // a variant found in no post is dropped by the counts below
  for (const [cat, atoms] of Object.entries(SEED_ATOMS) as [MinedCategory, string[]][]) for (const a of atoms) vote(a, cat);

  const category = new Map([...votes].map(([atom, m]) => [atom, [...m].sort((a, b) => b[1] - a[1])[0]![0]]));
  const all = compileAtoms(Object.fromEntries(MINED_CATEGORIES.map((c) => [c, [...category].filter(([, k]) => k === c).map(([a]) => a)])));

  interface Stat {
    pos: number;
    neg: number;
    verticals: Set<string>;
    recruiter: number;
    employer: number;
    nonDeskTitle: number;
    deskTitle: number;
  }
  const stats = new Map<string, Stat>();
  const stat = (a: string) => {
    let s = stats.get(a);
    if (!s) stats.set(a, (s = { pos: 0, neg: 0, verticals: new Set(), recruiter: 0, employer: 0, nonDeskTitle: 0, deskTitle: 0 }));
    return s;
  };
  for (const [id, l] of mining) {
    const t = text.get(id)!;
    const positive = isPositive(l);
    for (const a of findAtoms(all, t.all)) {
      const s = stat(a);
      if (positive) {
        s.pos++;
        s.verticals.add(l.vertical ?? "sprint0");
      } else s.neg++;
      if (l.recruiter) s.recruiter++;
      else s.employer++;
    }
    for (const a of findAtoms(all, t.title)) {
      if (l.desk_role) stat(a).deskTitle++;
      else stat(a).nonDeskTitle++;
    }
  }

  const seeds = new Set(Object.values(SEED_ATOMS).flat());
  const keep = (atom: string, cat: MinedCategory): boolean => {
    const s = stats.get(atom);
    if (seeds.has(atom)) return true; // §6.6 seeds stay even when job posts never use them
    if (!s) return false;
    if (cat === "RECRUITER") return s.recruiter >= 2 && s.employer === 0;
    if (cat === "PHYSICAL_ROLE") return s.nonDeskTitle > 0 && s.deskTitle === 0;
    return s.pos > 0 && s.pos / (s.pos + s.neg) >= MIN_SHARE;
  };

  const core: Partial<Record<MinedCategory, string[]>> = {};
  const byVertical: Partial<Record<VerticalSlug, Partial<Record<MinedCategory, string[]>>>> = {};
  const add = (list: Partial<Record<MinedCategory, string[]>>, cat: MinedCategory, atom: string) => (list[cat] ??= []).push(atom);
  for (const [atom, cat] of category) {
    if (seeds.has(atom) || !keep(atom, cat)) continue; // seeds ship from gate.ts
    const s = stats.get(atom)!;
    const vs = [...s.verticals].filter((v) => v !== "sprint0") as VerticalSlug[];
    if (cat === "RECRUITER" || cat === "PHYSICAL_ROLE" || s.verticals.size >= CORE_VERTICALS || vs.length === 0) add(core, cat, atom);
    else for (const v of vs) add((byVertical[v] ??= {}), cat, atom);
  }
  const sortList = (l: Partial<Record<MinedCategory, string[]>>) =>
    Object.fromEntries(MINED_CATEGORIES.filter((c) => l[c]?.length).map((c) => [c, [...new Set(l[c])].sort()]));
  const out = {
    builtAt: new Date().toISOString(),
    core: sortList(core),
    vertical: Object.fromEntries(Object.keys(SEARCH_TITLES).filter((v) => byVertical[v as VerticalSlug]).map((v) => [v, sortList(byVertical[v as VerticalSlug]!)])),
  };
  writeFileSync(
    ATOMS_FILE,
    `// Generated by \`npm run mine -- build\` (PRD §6.3) from ${mining.length} labelled mining posts. Do not edit by
// hand; re-run the build. §6.6 seed atoms live in gate.ts.
import type { AtomList } from "./gate.ts";
import type { VerticalSlug } from "./verticals.ts";

export const MINED_ATOMS: { builtAt: string | null; core: AtomList; vertical: Partial<Record<VerticalSlug, AtomList>> } = ${JSON.stringify(out, null, 2)};
`,
  );
  const count = (l: object) => Object.values(l).reduce((n: number, a: string[]) => n + a.length, 0);
  console.log(`mining posts ${mining.length}; phrases copied ${copied}, paraphrased (dropped) ${paraphrased}; candidates ${category.size}`);
  console.log(`core atoms ${count(out.core)}`, Object.fromEntries(Object.entries(out.core).map(([c, a]) => [c, a.length])));
  console.log("vertical atoms", Object.fromEntries(Object.entries(out.vertical).map(([v, l]) => [v, count(l)])));
}

// ── eval ───────────────────────────────────────────────────────────────────
// Runs the shipped gate (atoms.ts as built) on the held-out posts. Re-run after `build`.
async function evalGate() {
  const labels = load<Record<string, LabelledPost>>(LABELS, {});
  const { posts } = load<PostsFile>(POSTS, { posts: [], fetched: [], apifyUsd: 0 });
  const rows = posts
    .filter((p) => labels[p.id]?.role === "eval")
    .map((p) => {
      const l = labels[p.id]!;
      const g = gateJobPost(p, p.vertical);
      return { vertical: p.vertical, positive: isPositive(l), passed: g.pass, post: p, label: l, gate: g };
    });
  const r = recallReport(rows);
  const reviewed = rows.filter((x) => x.label.reviewed).length;
  console.log(`eval posts ${rows.length} (${reviewed} reviewed by the operator), positives ${r.pooled.positives}`);
  console.log(`pooled recall ${(r.pooled.recall * 100).toFixed(1)} %, precision ${(r.pooled.precision * 100).toFixed(1)} %; gate ${r.gateMet ? "MET" : "NOT met"}`);
  for (const [v, x] of Object.entries(r.byVertical).sort((a, b) => a[1].recall - b[1].recall))
    console.log(`  ${v.padEnd(22)} recall ${(x.recall * 100).toFixed(0).padStart(3)} %  (${x.positives} positive of ${x.posts})${x.recall < 0.7 ? "  ← below 70 %" : ""}`);
  const misses = rows.filter((x) => x.positive && !x.passed);
  save(`${DIR}/eval.json`, {
    at: new Date().toISOString(),
    report: r,
    misses: misses.map((x) => ({ id: x.post.id, vertical: x.vertical, title: x.post.title, reason: x.gate.pass ? null : x.gate.reason, matched: x.gate.matches, llm: x.label.reason })),
  });
  console.log(`misses → ${DIR}/eval.json`);
}

// ── review / apply ─────────────────────────────────────────────────────────
// Operator review of the eval labels (§6.3 step 3), limited to where a wrong label changes the
// result: gate misses, gate passes the LLM called negative, and 3 random agreed posts per
// vertical as a spot check. `review` writes a local page; its Save button downloads the answers;
// `apply <file>` writes them into labels.json (operator answer wins) and marks them reviewed.
const REVIEW = `${DIR}/review.html`;
const SPOT = 3;

async function writeReview() {
  const labels = load<Record<string, LabelledPost>>(LABELS, {});
  const { posts } = load<PostsFile>(POSTS, { posts: [], fetched: [], apifyUsd: 0 });
  const rows = posts
    .filter((p) => labels[p.id]?.role === "eval")
    .map((p) => {
      const l = labels[p.id]!;
      const g = gateJobPost(p, p.vertical);
      return { p, l, g, positive: isPositive(l) };
    });
  const pick = (r: (typeof rows)[number], group: string) => ({
    id: r.p.id,
    group,
    vertical: r.p.vertical,
    country: r.p.country,
    title: r.p.title,
    company: r.p.company,
    url: r.p.url,
    text: r.p.description.slice(0, 6000),
    llm: { desk_role: r.l.desk_role, recruiter: r.l.recruiter, automatable: r.l.automatable, reason: r.l.reason, lead: r.positive },
    gate: r.g.pass ? "passed" : `dropped (${r.g.reason})`,
    matched: r.g.matches.map((m) => m.atom),
    reviewed: r.l.reviewed ? (isPositive(r.l) ? "lead" : r.l.recruiter ? "recruiter" : "not") : null,
  });
  const misses = rows.filter((r) => r.positive && !r.g.pass).map((r) => pick(r, "Gate dropped it, AI says lead"));
  const extra = rows.filter((r) => !r.positive && r.g.pass).map((r) => pick(r, "Gate passed it, AI says not a lead"));
  const rest = rows.filter((r) => r.positive === r.g.pass);
  const spot = Object.keys(SEARCH_TITLES).flatMap((v) =>
    rest
      .filter((r) => r.p.vertical === v)
      .sort((a, b) => a.p.id.localeCompare(b.p.id))
      .slice(0, SPOT)
      .map((r) => pick(r, "Spot check (gate and AI agree)")),
  );
  const scoped = await withScope([...misses, ...extra, ...spot], new Map(rows.map((r) => [r.p.id, r.p])));
  const json = JSON.stringify(scoped).replace(/</g, "\\u003c");
  save(REVIEW, ""); // creates the directory
  writeFileSync(REVIEW, reviewPage(json));
  const items = scoped;
  console.log(`${items.length} posts to review (${misses.length} misses, ${extra.length} extra passes, ${spot.length} spot checks)`);
  console.log(`open ${REVIEW} in a browser; Save downloads review-answers.json; then: npm run mine -- apply ~/Downloads/review-answers.json`);
}

// The dashboard's Full/Partial tag comes from the extract-llm step; the review page shows the
// same thing, so it runs that prompt once per review post (cached in extract.json).
const EXTRACT = `${DIR}/extract.json`;
type Extracted = { pct: number | null; fit: string; pitch: string | null };

async function withScope<T extends { id: string }>(items: T[], posts: Map<string, MinePost>) {
  const cache = load<Record<string, Extracted>>(EXTRACT, {});
  const todo = items.filter((it) => !cache[it.id]);
  if (todo.length) {
    console.log(`extracting ${todo.length} posts for the automation scope`);
    const pool = createPool(2);
    const llm = gatedLlm(pool, new OpenRouterClient(), { monthlyCapUsd: Number(process.env.MONTHLY_CAP_USD ?? 20) });
    let cost = 0;
    const queue = [...todo];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let it = queue.shift(); it; it = queue.shift()) {
          const p = posts.get(it.id)!;
          try {
            const r = await llm.json("extraction", buildJobExtraction({ title: p.title, company: p.company, location: null, description: p.description }));
            cost += r.costUsd;
            cache[it.id] = { pct: r.data.automatable_task_percentage, fit: r.data.automation_fit, pitch: r.data.proposed_ai_replacement };
            save(EXTRACT, cache);
          } catch (e) {
            console.log(`extraction failed for ${it.id} (re-run to retry): ${(e as Error).message.slice(0, 160)}`);
          }
        }
      }),
    );
    await pool.end();
    console.log(`extraction cost $${cost.toFixed(4)}`);
  }
  return items.map((it) => {
    const x = cache[it.id];
    const scope = x ? scopeOf(x.pct) : null;
    return { ...it, scope: scope ? { label: SCOPE_LABEL[scope], kind: scope, pct: x!.pct, pitch: x!.pitch } : null };
  });
}

async function applyReview() {
  const file = positionals[1];
  if (!file) throw new Error("usage: npm run mine -- apply <review-answers.json>");
  const answers = z.record(z.string(), z.enum(["lead", "not", "recruiter"])).parse(JSON.parse(readFileSync(file, "utf8")));
  const labels = load<Record<string, LabelledPost>>(LABELS, {});
  let changed = 0;
  for (const [id, a] of Object.entries(answers)) {
    const l = labels[id];
    if (!l || l.role !== "eval") continue;
    const before = isPositive(l);
    if (a === "lead") Object.assign(l, { desk_role: true, recruiter: false, automatable: l.automatable === "none" ? "some" : l.automatable });
    if (a === "not") Object.assign(l, { recruiter: false, automatable: "none" });
    if (a === "recruiter") l.recruiter = true;
    l.reviewed = true;
    if (isPositive(l) !== before) changed++;
  }
  save(LABELS, labels);
  console.log(`${Object.keys(answers).length} answers applied, ${changed} labels changed. Re-run: npm run mine -- eval`);
}

function reviewPage(json: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Label review</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1c1c1a;--muted:#6b6b66;--line:#e2e2dc;--accent:#2f5d50;--warn:#9a5b13}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--ink:#ecece8;--muted:#a3a39c;--line:#34342f;--accent:#7fbfa9;--warn:#e0a458}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
main{max-width:860px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px}
.group{font-size:13px;font-weight:600;color:var(--warn);text-transform:uppercase;letter-spacing:.04em}
h1{font-size:22px;margin:6px 0 2px}.meta{color:var(--muted);font-size:14px}
.ai{margin:14px 0;padding:10px 12px;border-left:3px solid var(--accent);background:var(--bg);font-size:15px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.chips span{font-size:13px;border:1px solid var(--line);border-radius:999px;padding:2px 10px}
.text{white-space:pre-wrap;max-height:50vh;overflow:auto;border-top:1px solid var(--line);padding-top:12px;margin-top:12px;font-size:15px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
button{font:inherit;min-height:44px;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.on{background:var(--accent);color:var(--bg);border-color:var(--accent)}
button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
a{color:var(--accent)}.grow{flex:1}
.scope{margin:10px 0;padding:8px 12px;border-radius:8px;border:1px solid var(--line);font-size:15px}
.scope.full{border-color:#1d8a5a;background:color-mix(in srgb,#1d8a5a 12%,transparent)}
.scope.partial{border-color:#2f6fed;background:color-mix(in srgb,#2f6fed 10%,transparent)}
.scope.none{color:var(--muted)}
</style></head><body>
<header><strong>Label review</strong><span id="progress" class="meta"></span><span class="grow"></span>
<button id="prev">← Back</button><button id="next">Skip →</button><button id="save">Save answers</button></header>
<main><div class="card" id="card"></div>
<p class="meta">Keys: <b>L</b> lead · <b>N</b> not a lead · <b>R</b> recruiter · ← → move. A lead = a desk job at the employer itself with some repetitive admin that software or AI could take over.</p></main>
<script>
const items = ${json};
const KEY = "label-review-answers";
let answers = {};
try { answers = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
for (const it of items) if (it.reviewed && !answers[it.id]) answers[it.id] = it.reviewed;
let i = Math.max(0, items.findIndex((it) => !answers[it.id]));
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
function render() {
  const it = items[i], card = document.getElementById("card");
  const done = items.filter((x) => answers[x.id]).length;
  document.getElementById("progress").textContent = (i + 1) + " of " + items.length + " · " + done + " answered";
  const ai = it.llm.lead ? "Lead" : it.llm.recruiter ? "Recruiter" : "Not a lead";
  const btn = (label, value) => { const b = el("button", { textContent: label, className: answers[it.id] === value ? "on" : "" }); b.onclick = () => answer(value); return b; };
  card.replaceChildren(
    el("div", { className: "group", textContent: it.group }),
    el("h1", { textContent: it.title }),
    el("div", { className: "meta" }, (it.company || "Unknown company") + " · " + it.vertical.replace(/_/g, " ") + " · " + it.country.toUpperCase() + " · ", el("a", { href: it.url, target: "_blank", rel: "noopener noreferrer", textContent: "Open post" })),
    el("div", { className: "ai" }, el("strong", { textContent: "AI: " + ai }), " (" + it.llm.automatable + " automatable work) — " + it.llm.reason, el("br"), "Gate: " + it.gate),
    it.scope ? el("div", { className: "scope " + it.scope.kind }, el("strong", { textContent: it.scope.label + " · " + it.scope.pct + "%" }), it.scope.pitch ? " — pitch: " + it.scope.pitch : "") : el("div", { className: "scope none", textContent: "No automation estimate" }),
    el("div", { className: "chips" }, ...(it.matched.length ? it.matched.map((m) => el("span", { textContent: m })) : [el("span", { textContent: "no phrases matched" })])),
    el("div", { className: "actions" }, btn("Lead (L)", "lead"), btn("Not a lead (N)", "not"), btn("Recruiter (R)", "recruiter")),
    el("div", { className: "text", textContent: it.text }),
  );
}
function answer(v) { answers[items[i].id] = v; try { localStorage.setItem(KEY, JSON.stringify(answers)); } catch {} if (i < items.length - 1) i++; render(); }
document.getElementById("prev").onclick = () => { if (i > 0) i--; render(); };
document.getElementById("next").onclick = () => { if (i < items.length - 1) i++; render(); };
document.getElementById("save").onclick = () => {
  const a = el("a", { href: URL.createObjectURL(new Blob([JSON.stringify(answers, null, 1)], { type: "application/json" })), download: "review-answers.json" });
  a.click();
};
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "l") answer("lead"); else if (k === "n") answer("not"); else if (k === "r") answer("recruiter");
  else if (e.key === "ArrowRight") document.getElementById("next").click(); else if (e.key === "ArrowLeft") document.getElementById("prev").click();
});
render();
</script></body></html>
`;
}

const steps: Record<string, () => Promise<void>> = {
  fetch: fetchPosts,
  label: labelPosts,
  build: buildAtoms,
  eval: evalGate,
  review: writeReview,
  apply: applyReview,
};
const step = steps[positionals[0] ?? ""];
if (!step) throw new Error(`step must be one of: ${Object.keys(steps).join(", ")}`);
await step();
