// Refreshes the tech-stack fingerprints (PRD §5.4 step 3) from enthec/webappanalyzer (GPL-3.0),
// pinned to one commit. Keeps only what a plain HTTP fetch can match (no JS globals, XHR, DNS,
// CSS), so the file stays small. Usage: npm run fingerprints:update -- [--ref <commit sha>]
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { ref: { type: "string", default: "c708f0b2894cee70bb3b2eddde37dcb05595800c" } } });
const ref = values.ref!;
if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error("--ref must be a full commit sha");
const BASE = `https://raw.githubusercontent.com/enthec/webappanalyzer/${ref}/src`;
const KEEP = ["cats", "headers", "cookies", "meta", "html", "scriptSrc", "scripts", "dom", "text", "url", "implies", "requires", "requiresCategory", "excludes", "saas"];
const OUT = "packages/integrations/data";

async function get(path: string): Promise<Record<string, Record<string, unknown>>> {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, Record<string, unknown>>;
}

const technologies: Record<string, Record<string, unknown>> = {};
for (const f of ["_", ..."abcdefghijklmnopqrstuvwxyz"]) {
  for (const [name, tech] of Object.entries(await get(`technologies/${f}.json`))) {
    technologies[name] = Object.fromEntries(KEEP.filter((k) => tech[k] !== undefined).map((k) => [k, tech[k]]));
  }
}
const categories = Object.fromEntries(Object.entries(await get("categories.json")).map(([id, c]) => [id, c.name]));
if (Object.keys(technologies).length < 5000) throw new Error(`only ${Object.keys(technologies).length} technologies; refusing to write`);

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/webappanalyzer.json`, JSON.stringify({ source: `enthec/webappanalyzer@${ref} (GPL-3.0)`, categories, technologies }));
console.log(`${Object.keys(technologies).length} technologies, ${Object.keys(categories).length} categories → ${OUT}/webappanalyzer.json`);
