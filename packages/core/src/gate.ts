// gate-job-post (PRD §5.1 step 3) — free, before any paid call.
// Sprint 1 stand-in: hand-written seed atoms. Sprint 2 replaces these lists with tries mined
// from real posts (§6.3); the rule stays the same: drop recruiters, require ≥ 2 atoms across
// AUTOMATABLE_TASK / INFORMATION_SILO / DOCUMENT_FRICTION, and a desk role.
// Atoms match whole words; a trailing * makes a stem ("reconcil*" → reconcile, reconciliation).

export type AtomCategory = "AUTOMATABLE_TASK" | "INFORMATION_SILO" | "DOCUMENT_FRICTION" | "OWNER_DEPENDENCY" | "RECRUITER";

const ATOMS: Record<AtomCategory, string[]> = {
  AUTOMATABLE_TASK: [
    "data entry", "enter data", "key in", "keying", "update records", "maintain records", "spreadsheet*", "excel",
    "invoice*", "invoicing", "billing", "accounts payable", "accounts receivable", "reconcil*", "bookkeeping", "ledger*",
    "purchase order", "sales order", "order processing", "order entry", "payroll", "timesheet", "quotation", "quotes",
    "data management", "crm", "tally", "quickbooks", "zoho books", "xero", "sap", "erp", "mis report*", "report*",
    "follow up", "follow-up", "schedul*", "appointment*", "dispatch*", "tracking", "inventory", "stock",
    "copy and paste", "manual", "repetitive",
  ],
  DOCUMENT_FRICTION: [
    "paperwork", "documentation", "document*", "filing", "file management", "scan*", "digitiz*", "digitis*",
    "physical copies", "physical files", "forms", "pdf", "receipts", "vouchers", "kyc", "claims",
  ],
  INFORMATION_SILO: [
    "sop*", "standard operating procedure*", "organize company drive", "organise company drive", "company drive",
    "documenting procedures", "document procedures", "centralize", "centralise", "knowledge base", "training material",
  ],
  OWNER_DEPENDENCY: ["rely on the owner", "only the founder knows", "answering questions", "report directly to the owner"],
  RECRUITER: [
    "our client", "on behalf of our client", "for our client", "staffing", "recruitment agency", "placement agency",
    "manpower", "consultancy is hiring", "we are hiring for", "hiring for a leading", "contract-to-hire", "c2h",
  ],
};

// Physical, clinical and field titles fail the desk-role check (§5.1 step 3).
const NON_DESK_TITLE =
  /\b(driver|delivery|warehouse|picker|packer|loader|forklift|cleaner|janitor|housekeep|cook|chef|kitchen|waiter|barista|nurse|caregiver|physician|doctor|dentist|hygienist|therapist|technician|mechanic|electrician|plumber|welder|carpenter|painter|labou?rer|security guard|guard|cashier|sales associate|field sales|merchandiser|teacher|tutor|driver)\b/i;

export interface GateMatch {
  category: AtomCategory;
  atom: string;
}

export function matchAtoms(text: string): GateMatch[] {
  const t = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  const out: GateMatch[] = [];
  for (const [category, atoms] of Object.entries(ATOMS) as [AtomCategory, string[]][]) {
    for (const atom of atoms) {
      const stem = atom.endsWith("*");
      const word = (stem ? atom.slice(0, -1) : atom).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^a-z])${word}${stem ? "" : "(?![a-z])"}`);
      if (re.test(t)) out.push({ category, atom });
    }
  }
  return out;
}

export type GateResult =
  | { pass: true; matches: GateMatch[]; founderDependency: boolean }
  | { pass: false; reason: "recruiter" | "trie"; matches: GateMatch[] };

export function gateJobPost(post: { title: string; description: string }): GateResult {
  const matches = matchAtoms(`${post.title}\n${post.description}`);
  if (matches.some((m) => m.category === "RECRUITER")) return { pass: false, reason: "recruiter", matches };
  const work = matches.filter((m) => m.category === "AUTOMATABLE_TASK" || m.category === "INFORMATION_SILO" || m.category === "DOCUMENT_FRICTION");
  if (work.length < 2 || NON_DESK_TITLE.test(post.title)) return { pass: false, reason: "trie", matches };
  // §6.6: any INFORMATION_SILO or OWNER_DEPENDENCY atom forces founder_dependency_flag (+10, once).
  const founderDependency = matches.some((m) => m.category === "INFORMATION_SILO" || m.category === "OWNER_DEPENDENCY");
  return { pass: true, matches, founderDependency };
}
