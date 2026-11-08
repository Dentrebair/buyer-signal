// Pain types (§10.1 filter): what kind of manual work a signal shows, from the keyword categories
// it matched; website findings are their own type. Stored on each challenge.
import type { AtomCategory } from "./gate.ts";

export const PAIN_TYPES = ["manual_work", "integration_debt", "document_friction", "information_silo", "web"] as const;
export type PainType = (typeof PAIN_TYPES)[number];

export const PAIN_TYPE_LABEL: Record<PainType, string> = {
  manual_work: "Manual desk work",
  integration_debt: "Copying between systems",
  document_friction: "Paper and documents",
  information_silo: "Scattered knowledge",
  web: "Website or WhatsApp",
};

const BY_CATEGORY: Partial<Record<AtomCategory, PainType>> = {
  AUTOMATABLE_TASK: "manual_work",
  MANUAL_ROLE: "manual_work",
  INTEGRATION_DEBT: "integration_debt",
  DOCUMENT_FRICTION: "document_friction",
  INFORMATION_SILO: "information_silo",
  OWNER_DEPENDENCY: "information_silo",
};

export function painTypesOf(sourceType: string, categories: readonly AtomCategory[]): PainType[] {
  if (sourceType === "dom_sniff" || sourceType === "tech_stack") return ["web"];
  const out = new Set<PainType>();
  for (const c of categories) {
    const t = BY_CATEGORY[c];
    if (t) out.add(t);
  }
  return PAIN_TYPES.filter((t) => out.has(t));
}
