// Automation scope from the extraction's automatable_task_percentage: at 70 %+ of the listed
// duties, the role itself could mostly be automated ("full"); below that, parts of it ("partial").
// Browser-safe (no dependencies): the inbox and the mining review page both use it.
export const FULL_AUTOMATION_PCT = 70;
export const SCOPES = ["full", "partial"] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_LABEL: Record<Scope, string> = { full: "Full automation", partial: "Partial automation" };
export const scopeOf = (pct: number | null): Scope | null => (pct === null ? null : pct >= FULL_AUTOMATION_PCT ? "full" : "partial");
