// gate-job-post (PRD §5.1 step 3) — free, before any paid call.
// Atoms are mined from real posts (§6.3, `npm run mine`) into atoms.ts: one shared core list
// plus each vertical's own terms. The rule: drop recruiters; require ≥ 2 distinct work atoms
// and a desk role. Atoms match whole words through a word trie; a trailing * makes the last
// word a stem ("reconcil*" → reconcile, reconciliation). "follow-up" and "follow up" are the
// same atom, since text and atoms are both split into words.
import { MINED_ATOMS } from "./atoms.ts";
import type { MinedCategory } from "./mining.ts";
import type { VerticalSlug } from "./verticals.ts";

export type AtomCategory = MinedCategory;
export type AtomList = Partial<Record<AtomCategory, string[]>>;

// Categories that count towards the ≥ 2 atoms. §5.1 names AUTOMATABLE_TASK, INFORMATION_SILO
// and DOCUMENT_FRICTION; mining added MANUAL_ROLE (titles such as "data entry operator") and
// INTEGRATION_DEBT (copying between systems), which describe the same work.
const WORK: ReadonlySet<AtomCategory> = new Set(["AUTOMATABLE_TASK", "MANUAL_ROLE", "INTEGRATION_DEBT", "DOCUMENT_FRICTION", "INFORMATION_SILO"]);

// §6.6 seeds: rare in job posts, so mining can't confirm them, but the PRD defines them.
export const SEED_ATOMS: AtomList = {
  INFORMATION_SILO: [
    "sop*", "standard operating procedure*", "organize company drive", "organise company drive", "organize the company drive",
    "organise the company drive", "company drive", "documenting procedures", "document procedures", "centralize company documentation",
    "centralise company documentation", "knowledge base", "training material*",
  ],
  OWNER_DEPENDENCY: ["rely on the owner", "only the founder knows", "answering questions my team", "report directly to the owner"],
  // §1.1 shadow IT: data bridged between systems by hand (2026-11-07; mining found none).
  INTEGRATION_DEBT: [
    "cross-referenc*", "cross referenc*", "between systems", "across systems", "multiple systems", "re-key*", "rekey*",
    "re-enter*", "double entry", "duplicate data entry", "sync data between", "copy data between",
  ],
  // Generic recruiter wording; mined recruiter phrases are often one agency's boilerplate.
  RECRUITER: [
    "on behalf of our client", "our client is seeking", "our client is looking", "hiring for our client", "for a leading client",
    "staffing agency", "recruitment agency", "placement agency", "placement consultancy",
  ],
};

// Physical, clinical and field titles fail the desk-role check (§5.1 step 3).
const NON_DESK_TITLE =
  /\b(driver|delivery|warehouse|picker|packer|loader|forklift|cleaner|janitor|housekeep|cook|chef|kitchen|waiter|barista|nurse|caregiver|physician|doctor|dentist|hygienist|therapist|technician|mechanic|electrician|plumber|welder|carpenter|painter|labou?rer|security guard|guard|cashier|sales associate|field sales|merchandiser|teacher|tutor)\b/i;

export function words(text: string): string[] {
  return text.toLowerCase().replace(/[‘’']/g, "").match(/[a-z0-9]+\*?/g) ?? [];
}

interface Node {
  next: Map<string, Node>;
  stems: { prefix: string; atoms: Atom[] }[];
  atoms: Atom[];
}
interface Atom {
  category: AtomCategory;
  atom: string;
  length: number;
}
export interface Trie {
  root: Node;
}

const node = (): Node => ({ next: new Map(), stems: [], atoms: [] });

export function compileAtoms(...lists: AtomList[]): Trie {
  const root = node();
  for (const list of lists)
    for (const [category, atoms] of Object.entries(list) as [AtomCategory, string[]][])
      for (const atom of atoms) {
        const ws = words(atom);
        if (!ws.length) continue;
        let n = root;
        for (const w of ws.slice(0, -1)) {
          const key = w.replace(/\*$/, "");
          if (!n.next.has(key)) n.next.set(key, node());
          n = n.next.get(key)!;
        }
        const last = ws[ws.length - 1]!;
        const a = { category, atom, length: ws.length };
        if (last.endsWith("*")) {
          const prefix = last.slice(0, -1);
          const s = n.stems.find((x) => x.prefix === prefix);
          if (s) s.atoms.push(a);
          else n.stems.push({ prefix, atoms: [a] });
        } else {
          if (!n.next.has(last)) n.next.set(last, node());
          n.next.get(last)!.atoms.push(a);
        }
      }
  return { root };
}

export interface GateMatch {
  category: AtomCategory;
  atom: string;
}

interface Found {
  start: number;
  end: number;
  a: Atom;
}

function scan(trie: Trie, ws: string[]): Found[] {
  const found: Found[] = [];
  for (let i = 0; i < ws.length; i++) {
    let n: Node | undefined = trie.root;
    for (let j = i; n && j < ws.length; j++) {
      const w = ws[j]!;
      for (const s of n.stems) if (w.startsWith(s.prefix)) for (const a of s.atoms) found.push({ start: i, end: j + 1, a });
      n = n.next.get(w);
      if (n) for (const a of n.atoms) found.push({ start: i, end: j + 1, a });
    }
  }
  return found;
}

// Every atom that occurs anywhere, overlaps included (mining statistics).
export function findAtoms(trie: Trie, text: string): Set<string> {
  return new Set(scan(trie, words(text)).map((f) => f.a.atom));
}

// Atoms found, longest match first where two overlap, each atom once.
export function matchTrie(trie: Trie, text: string): GateMatch[] {
  const found = scan(trie, words(text)).sort((x, y) => y.end - y.start - (x.end - x.start) || x.start - y.start);
  const taken = new Set<number>();
  const seen = new Set<string>();
  const out: GateMatch[] = [];
  for (const f of found) {
    let free = true;
    for (let k = f.start; k < f.end; k++) if (taken.has(k)) free = false;
    if (!free) continue;
    for (let k = f.start; k < f.end; k++) taken.add(k);
    if (seen.has(f.a.atom)) continue;
    seen.add(f.a.atom);
    out.push({ category: f.a.category, atom: f.a.atom });
  }
  return out;
}

const tries = new Map<VerticalSlug | "core", Trie>();
function shippedTrie(vertical: VerticalSlug | null | undefined): Trie {
  const key = vertical ?? "core";
  let t = tries.get(key);
  if (!t) {
    t = compileAtoms(SEED_ATOMS, MINED_ATOMS.core, vertical ? (MINED_ATOMS.vertical[vertical] ?? {}) : {});
    tries.set(key, t);
  }
  return t;
}

export function matchAtoms(text: string, vertical?: VerticalSlug | null, trie = shippedTrie(vertical)): GateMatch[] {
  return matchTrie(trie, text);
}

// LinkedIn snippets (§4.1a) are ~2 sentences, so one work atom is enough; recruiters still drop.
export function gateSnippet(text: string, vertical?: VerticalSlug | null, trie = shippedTrie(vertical)): GateResult {
  const matches = matchTrie(trie, text);
  if (matches.some((m) => m.category === "RECRUITER")) return { pass: false, reason: "recruiter", matches };
  if (!matches.some((m) => WORK.has(m.category))) return { pass: false, reason: "trie", matches };
  const founderDependency = matches.some((m) => m.category === "INFORMATION_SILO" || m.category === "OWNER_DEPENDENCY");
  return { pass: true, matches, founderDependency };
}

export type GateResult =
  | { pass: true; matches: GateMatch[]; founderDependency: boolean }
  | { pass: false; reason: "recruiter" | "trie"; matches: GateMatch[] };

export function gateJobPost(post: { title: string; description: string }, vertical?: VerticalSlug | null, trie = shippedTrie(vertical)): GateResult {
  const matches = matchTrie(trie, `${post.title}\n${post.description}`);
  if (matches.some((m) => m.category === "RECRUITER")) return { pass: false, reason: "recruiter", matches };
  const physical = NON_DESK_TITLE.test(post.title) || matchTrie(trie, post.title).some((m) => m.category === "PHYSICAL_ROLE");
  const work = matches.filter((m) => WORK.has(m.category));
  if (work.length < 2 || physical) return { pass: false, reason: "trie", matches };
  // §6.6: any INFORMATION_SILO or OWNER_DEPENDENCY atom forces founder_dependency_flag (+10, once).
  const founderDependency = matches.some((m) => m.category === "INFORMATION_SILO" || m.category === "OWNER_DEPENDENCY");
  return { pass: true, matches, founderDependency };
}
