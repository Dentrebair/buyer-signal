// Daily alert (Q65, §18.9): one email a day when something needs the operator: a budget at 80 %
// or more, a run that failed, jobs that failed for good, a health number that moved the wrong
// way, or no new card in 24 h on a day searches ran. Pure: the worker gathers, this decides.

export const BUDGET_ALERT_SHARE = 0.8;

export type AlertKind = "apify_budget" | "ai_budget" | "failed_runs" | "dead_jobs" | "no_cards" | "drift";
export interface Alert {
  kind: AlertKind;
  message: string;
}

export interface AlertInput {
  apify: { spent: number; cap: number } | null; // this billing cycle
  ai: { spent: number; cap: number } | null; // this month
  failedRuns: { source: string; n: number }[]; // last 24 h
  deadJobs: { queue: string; n: number }[]; // jobs that exhausted their retries, last 24 h
  cards24h: number;
  runs24h: number;
  rotationEnabled: boolean;
  driftWorse: string[]; // labels of health numbers that moved the wrong way at the latest check
}

const usd = (v: number) => `$${v.toFixed(2)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const SOURCE: Record<string, string> = { indeed: "job posts (Indeed)", li_posts: "LinkedIn post search", linkedin: "Google digest" };

export function dailyAlerts(x: AlertInput): Alert[] {
  const out: Alert[] = [];
  for (const [kind, label, b] of [["apify_budget", "Apify this billing cycle", x.apify], ["ai_budget", "AI this month", x.ai]] as const)
    if (b && b.cap > 0 && b.spent / b.cap >= BUDGET_ALERT_SHARE)
      out.push({ kind, message: `${label} is at ${pct(b.spent / b.cap)} of its cap (${usd(b.spent)} of ${usd(b.cap)}). Runs past the cap wait for the next period.` });
  if (x.failedRuns.length)
    out.push({ kind: "failed_runs", message: `Runs failed in the last 24 hours: ${x.failedRuns.map((r) => `${r.n} ${SOURCE[r.source] ?? r.source}`).join(", ")}.` });
  if (x.deadJobs.length)
    out.push({ kind: "dead_jobs", message: `Jobs failed for good after their retries: ${x.deadJobs.map((j) => `${j.n} ${j.queue}`).join(", ")}.` });
  // With the rotation off and nothing run by hand, no cards is expected, not an alert.
  if (x.cards24h === 0 && (x.rotationEnabled || x.runs24h > 0))
    out.push({ kind: "no_cards", message: `No new cards in the last 24 hours, though ${x.runs24h} ${x.runs24h === 1 ? "search ran" : "searches ran"}.` });
  if (x.driftWorse.length) out.push({ kind: "drift", message: `Health numbers that moved the wrong way this week: ${x.driftWorse.join(", ")}.` });
  return out;
}

export function alertEmail(alerts: Alert[], day: string, link: string): { subject: string; text: string } {
  return {
    subject: `Buying signal: ${alerts.length} ${alerts.length === 1 ? "thing needs" : "things need"} a look (${day})`,
    text: [...alerts.map((a) => `- ${a.message}`), "", `Health dashboard: ${link}`].join("\n"),
  };
}

// The email provider sits behind this (Q66); Resend in integrations, a fake in tests.
export interface Mailer {
  send(x: { subject: string; text: string }): Promise<void>;
}
