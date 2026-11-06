import { Briefcase, ChatsCircle, Globe, Tray } from "@phosphor-icons/react/ssr";
import type { SourceFamily } from "@bs/core";
import { FAMILY_LABEL } from "@/lib/labels.ts";

// LinkedIn and Reddit share the Social digest icon; the platform logo is on the post itself.
const ICON = { job_post: Briefcase, linkedin_post: ChatsCircle, social_post: ChatsCircle, website: Globe, inbound: Tray };

// Decorative next to visible text; otherwise labelled for screen readers.
export function FamilyIcon({ family, size = 16, labelled = true }: { family: SourceFamily; size?: number; labelled?: boolean }) {
  const Icon = ICON[family];
  return labelled ? (
    <span title={FAMILY_LABEL[family]} style={{ display: "inline-flex" }}>
      <Icon size={size} aria-hidden />
      <span className="sr-only">{FAMILY_LABEL[family]}</span>
    </span>
  ) : (
    <Icon size={size} aria-hidden />
  );
}
