// Urgency tier (PRD §1.1 signal taxonomy): fixed rules over the source, the author and the
// keywords in the evidence — never the AI's opinion — so the same post always gets the same tier.
// Browser-safe (no dependencies): the inbox shows and filters by it.
export const URGENCY_TIERS = ["high", "medium", "low"] as const;
export type UrgencyTier = (typeof URGENCY_TIERS)[number];
export const URGENCY_LABEL: Record<UrgencyTier, string> = { high: "High urgency", medium: "Medium urgency", low: "Low urgency" };

export const PRODUCT_LAYERS = ["knowledge_base", "company_brain", "company_os"] as const;
export const PRODUCT_LABEL: Record<(typeof PRODUCT_LAYERS)[number], string> = { knowledge_base: "Knowledge Base", company_brain: "Company Brain", company_os: "Company OS" };

// 🔴 "Fixer" hires: someone brought in to bring order to an owner-run business.
const FIXER_TITLE = /\b(chief of staff|director of operations|operations director|head of operations|process (consultant|improvement|excellence)|business process (analyst|manager)|business operations manager)\b/i;
const FIXER_TEXT = /\b(bring order to (the )?chaos|put(ting)? out fires|build (our|the) operating system|from scratch\b.{0,40}\b(process|systems?|operations))/i;
// 🔴 Founder vents: the owner is the bottleneck, in their own words.
const FOUNDER_VENT =
  /\b(1[2-8][- ]hour (work ?)?days|can'?t delegate|unable to delegate|(answer|answering) the same questions|everything (goes|runs) through me|i'?m the bottleneck|wear(ing)? (all|every|too many) (the )?hats|burn(ed|t|ing)? out)\b/i;

// 🟡 Medium needs the framework's pain, not a nearby keyword. Checked on the 68 stored signals
// (2026-11-07): a tool's name alone ("QuickBooks", "MS Excel") put 28 in Medium, and so did plain
// data entry ("enters data into smart sheets"), following SOPs, and a mined owner atom about POS
// support.
// Bridging systems by hand: data moved or checked between several systems.
const BRIDGING = /\b(between|across|sync\w*|cross[- ]?referenc\w*|consolidat\w*|re-?key\w*|re-?enter\w*|double entry|duplicate data entry|multiple (systems|programs|platforms|tools)|various (systems|programs|platforms))\b/i;
// Building the knowledge base: creating or organising SOPs and documents, not following them.
const BARE_SOP = /^(sop\*?|standard operating procedure\*?)$/i;
const SOP_BUILDING = /\b(creat|writ|develop|build|document|draft|maintain|updat|organi[sz])\w*\b[^.]{0,40}\b(sops?|standard operating procedures?)\b/i;
// Owner dependency names the owner.
const OWNER = /\b(owner|founder|ceo|managing director|proprietor|principal|boss|answering questions)\b/i;

export function isFixerHire(title: string, text = ""): boolean {
  return FIXER_TITLE.test(title) || FIXER_TEXT.test(text);
}

export function urgencyTier(x: {
  sourceType: string; // contracts SourceType
  authorRelation?: string | null;
  title?: string | null;
  text: string; // the evidence: title + description, or the post snippet
  matches: readonly { category: string; atom: string }[]; // gate atoms matched in `text`
}): UrgencyTier {
  if (x.sourceType === "dom_sniff" || x.sourceType === "tech_stack") return "low"; // passive structural debt
  const counts = (m: { category: string; atom: string }) =>
    m.category === "INTEGRATION_DEBT"
      ? BRIDGING.test(m.atom)
      : m.category === "INFORMATION_SILO"
        ? !BARE_SOP.test(m.atom) || SOP_BUILDING.test(x.text)
        : m.category === "OWNER_DEPENDENCY"
          ? OWNER.test(m.atom)
          : false;
  const has = (c: string) => x.matches.some((m) => m.category === c && counts(m));
  if (x.sourceType === "job_post" && isFixerHire(x.title ?? "", x.text)) return "high";
  if (x.authorRelation === "founder_owner" && (has("OWNER_DEPENDENCY") || FOUNDER_VENT.test(x.text))) return "high";
  if (has("INFORMATION_SILO") || has("INTEGRATION_DEBT") || has("OWNER_DEPENDENCY")) return "medium";
  return "low";
}
