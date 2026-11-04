// Tech-stack matcher (PRD §5.4 step 3): enthec/webappanalyzer fingerprints run against one
// plain HTTP fetch — headers, cookies, meta tags, HTML, script URLs, inline scripts, DOM
// selectors and visible text. Fingerprints that need a browser (JS globals, XHR, DNS) are
// dropped when the data file is built (scripts/fingerprints-update.ts).
import type { CheerioAPI } from "cheerio";

type Patterns = string | string[];
export interface Fingerprint {
  cats?: number[];
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  meta?: Record<string, Patterns>;
  html?: Patterns;
  scriptSrc?: Patterns;
  scripts?: Patterns;
  dom?: Patterns | Record<string, DomRule>;
  text?: Patterns;
  url?: Patterns;
  implies?: Patterns;
  requires?: Patterns;
  requiresCategory?: number | number[];
  excludes?: Patterns;
  saas?: boolean;
}
// `properties` (JS state on the element) needs a browser; a rule with only that is skipped.
interface DomRule {
  exists?: string;
  text?: string;
  attributes?: Record<string, string>;
  properties?: Record<string, string>;
}
export interface Fingerprints {
  categories: Record<string, string>;
  technologies: Record<string, Fingerprint>;
}

export interface Tech {
  name: string;
  version: string | null;
  categories: string[];
  saas: boolean;
}

export interface TechInput {
  $: CheerioAPI; // the page, before minify (scripts still in)
  url: string;
  headers: Record<string, string>; // lower-case names
  text: string; // visible text
}

interface Pattern {
  re: RegExp;
  version?: string;
}

const list = (p: Patterns | undefined): string[] => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
const MAX_SUBJECT = 500_000; // html and inline-script patterns run on at most this much text

// "pattern\;version:\1\;confidence:50" → regex + version template. Invalid regexes never match.
const cache = new Map<string, Pattern | null>();
function parse(raw: string): Pattern | null {
  const hit = cache.get(raw);
  if (hit !== undefined) return hit;
  const [src, ...tags] = raw.split("\\;");
  let p: Pattern | null;
  try {
    p = { re: new RegExp(src ?? "", "i") };
    const v = tags.find((t) => t.startsWith("version:"));
    if (v) p.version = v.slice(8);
  } catch {
    p = null;
  }
  cache.set(raw, p);
  return p;
}

// Version template: "\1", or the ternary form "\1?a:b" (a if group 1 matched, else b).
function version(p: Pattern, m: RegExpExecArray): string | null {
  if (!p.version) return null;
  const sub = (s: string) => s.replace(/\\(\d)/g, (_, i: string) => m[Number(i)] ?? "");
  const t = p.version.match(/^(.*?)\?(.*):(.*)$/);
  const out = t ? (sub(t[1]!) ? sub(t[2]!) : sub(t[3]!)) : sub(p.version);
  return out.trim() || null;
}

function test(raws: Patterns | undefined, subjects: string[]): { version: string | null } | null {
  for (const raw of list(raws)) {
    const p = parse(raw);
    if (!p) continue;
    for (const s of subjects) {
      const m = p.re.exec(s);
      if (m) return { version: version(p, m) };
    }
  }
  return null;
}

function cookieMap(headers: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (headers["set-cookie"] ?? "").split("\n")) {
    const [pair] = line.split(";");
    const i = pair?.indexOf("=") ?? -1;
    if (pair && i > 0) out.set(pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1).trim());
  }
  return out;
}

export function detectTech(fp: Fingerprints, x: TechInput): Tech[] {
  const { $ } = x;
  const html = $.html().slice(0, MAX_SUBJECT);
  const scriptSrc = $("script[src]").map((_, e) => $(e).attr("src") ?? "").get();
  const scripts = $("script:not([src])").map((_, e) => $(e).text().slice(0, 50_000)).get().join("\n").slice(0, MAX_SUBJECT);
  const meta = new Map<string, string[]>();
  $("meta").each((_, e) => {
    const name = ($(e).attr("name") ?? $(e).attr("property") ?? $(e).attr("http-equiv") ?? "").toLowerCase();
    const content = $(e).attr("content");
    if (name && content !== undefined) meta.set(name, [...(meta.get(name) ?? []), content]);
  });
  const cookies = cookieMap(x.headers);
  const lowerHtml = $.html().toLowerCase();

  const found = new Map<string, string | null>();
  for (const [name, t] of Object.entries(fp.technologies)) {
    const hit =
      matchMap(t.headers, (k) => (x.headers[k.toLowerCase()] !== undefined ? [x.headers[k.toLowerCase()]!] : null)) ??
      matchMap(t.cookies, (k) => cookieValues(cookies, k)) ??
      matchMap(t.meta, (k) => meta.get(k.toLowerCase()) ?? null) ??
      test(t.scriptSrc, scriptSrc) ??
      test(t.html, [html]) ??
      test(t.scripts, scripts ? [scripts] : []) ??
      test(t.url, [x.url]) ??
      test(t.text, [x.text]) ??
      matchDom($, t.dom, lowerHtml);
    if (hit) found.set(name, hit.version);
  }

  // implies (transitively), then requires / excludes.
  const queue = [...found.keys()];
  while (queue.length) {
    for (const raw of list(fp.technologies[queue.pop()!]?.implies)) {
      const name = raw.split("\\;")[0]!;
      if (fp.technologies[name] && !found.has(name)) {
        found.set(name, null);
        queue.push(name);
      }
    }
  }
  const cats = (name: string) => fp.technologies[name]?.cats ?? [];
  const foundCats = new Set([...found.keys()].flatMap(cats));
  for (const name of [...found.keys()]) {
    const t = fp.technologies[name]!;
    const req = list(t.requires).map((r) => r.split("\\;")[0]!);
    const reqCat = t.requiresCategory === undefined ? [] : Array.isArray(t.requiresCategory) ? t.requiresCategory : [t.requiresCategory];
    if ((req.length && !req.some((r) => found.has(r))) || (reqCat.length && !reqCat.some((c) => foundCats.has(c)))) found.delete(name);
  }
  for (const name of [...found.keys()]) for (const ex of list(fp.technologies[name]?.excludes)) found.delete(ex.split("\\;")[0]!);

  return [...found.entries()]
    .map(([name, v]) => ({
      name,
      version: v,
      categories: cats(name).map((c) => fp.categories[String(c)] ?? String(c)),
      saas: fp.technologies[name]!.saas === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Fingerprint maps: key present (pattern "") or key's value matches the pattern.
function matchMap(map: Record<string, Patterns> | undefined, values: (key: string) => string[] | null) {
  if (!map) return null;
  for (const [k, raws] of Object.entries(map)) {
    const vs = values(k);
    if (!vs) continue;
    for (const raw of list(raws)) {
      if (raw === "" || raw.startsWith("\\;")) return { version: null };
      const hit = test(raw, vs);
      if (hit) return hit;
    }
  }
  return null;
}

// Cookie names may end in "*" (e.g. "_ga_*").
function cookieValues(cookies: Map<string, string>, key: string): string[] | null {
  const k = key.toLowerCase();
  if (!k.endsWith("*")) return cookies.has(k) ? [cookies.get(k)!] : null;
  const vs = [...cookies.entries()].filter(([n]) => n.startsWith(k.slice(0, -1))).map(([, v]) => v);
  return vs.length ? vs : null;
}

function matchDom($: CheerioAPI, dom: Fingerprint["dom"], lowerHtml: string) {
  if (!dom) return null;
  const entries: [string, DomRule | null][] = typeof dom === "string" || Array.isArray(dom) ? list(dom).map((s) => [s, null]) : Object.entries(dom);
  for (const [selector, rule] of entries) {
    if (rule && rule.exists === undefined && !rule.text && !rule.attributes) continue; // properties only
    if (!mayMatch(selector, lowerHtml)) continue;
    let nodes;
    try {
      nodes = $(selector);
    } catch {
      continue; // selector cheerio can't parse
    }
    if (!nodes.length) continue;
    if (!rule || rule.exists !== undefined) return { version: null };
    for (const el of nodes.toArray()) {
      const $el = $(el);
      if (rule.text) {
        const hit = test(rule.text, [$el.text()]);
        if (hit) return hit;
      }
      for (const [attr, raw] of Object.entries(rule.attributes ?? {})) {
        const v = $el.attr(attr);
        if (v === undefined) continue;
        if (raw === "") return { version: null };
        const hit = test(raw, [v]);
        if (hit) return hit;
      }
    }
  }
  return null;
}

// Running ~1,600 selectors over a large page is slow (16 s on 1 MB), so first a cheap text check:
// every literal a selector needs (attribute value or name, #id, .class, custom tag) must occur in
// the HTML. Only skips selectors that cannot match; one with no literals always runs.
const literalsCache = new Map<string, string[][]>();
function mayMatch(selector: string, lowerHtml: string): boolean {
  let alts = literalsCache.get(selector);
  if (!alts) {
    alts = splitTopLevel(selector).map(literals);
    literalsCache.set(selector, alts);
  }
  return alts.some((lits) => lits.every((l) => lowerHtml.includes(l)));
}

function splitTopLevel(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function literals(alt: string): string[] {
  const out: string[] = [];
  const ok = (v: string) => v.length > 0 && !/[&<>"']/.test(v); // entity-encoded in serialised HTML
  // Attribute selectors: the value (and the attribute name) must be in the page.
  const noAttrs = alt.replace(/\[\s*([\w:-]+)\s*(?:[~|^$*]?=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*(?:[is]\s*)?)?\]/g, (_m, name: string, a?: string, b?: string, c?: string) => {
    const v = (a ?? b ?? c)?.toLowerCase();
    if (v !== undefined && ok(v)) out.push(v);
    out.push(name.toLowerCase());
    return " ";
  });
  // Pseudo-class arguments (:not(.x), :has(...)) can't be required; drop them.
  const plain = noAttrs.replace(/:[\w-]+\((?:[^()]|\([^()]*\))*\)/g, " ");
  for (const m of plain.matchAll(/[#.]([\w-]+)/g)) out.push(m[1]!.toLowerCase());
  for (const m of plain.matchAll(/(?:^|[\s>+~(])([a-z][\w]*-[\w-]+)/gi)) out.push(`<${m[1]!.toLowerCase()}`);
  return out;
}
