// The daily alert (Q65).
import {
  alertEmail,
  dailyAlerts,
} from "@bs/core";
import {
  alertInputs,
  saveAlerts,
} from "@bs/db";
import { type Deps } from "./deps.ts";

// ── daily-alerts (Q65) ──────────────────────────────────────────────────────
// After the night's jobs: what needs the operator is saved (shown on /health) and, when a mailer
// is set up, emailed once. A failed email is logged; the alerts stay saved.
export async function dailyAlertsJob(d: Pick<Deps, "pool" | "mailer" | "settings" | "now" | "log">): Promise<{ alerts: number; emailed: boolean }> {
  const day = d.now().toISOString().slice(0, 10);
  const alerts = dailyAlerts(await alertInputs(d.pool, d.settings.rotationEnabled));
  if (!alerts.length) return { alerts: 0, emailed: false };
  let emailed = false;
  if (d.mailer) {
    try {
      await d.mailer.send(alertEmail(alerts, day, d.settings.healthUrl));
      emailed = true;
    } catch (e) {
      d.log("alert email failed; alerts saved", { error: (e as Error).message });
    }
  }
  await saveAlerts(d.pool, day, alerts, emailed);
  d.log("daily alerts", { alerts: alerts.map((a) => a.kind), emailed });
  return { alerts: alerts.length, emailed };
}
