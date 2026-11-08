// Alert email through Resend's HTTPS API (Q65). The key goes in a header, never a URL. Without
// RESEND_API_KEY and ALERT_EMAIL_TO the worker sends nothing and the alerts stay on /health.
// Not yet exercised against the live API: it needs the operator's key (2026-11-08).
import type { Mailer } from "@bs/core";

export class ResendMailer implements Mailer {
  constructor(
    private key: string,
    private to: string,
    private from = "Buying signal <onboarding@resend.dev>", // Resend's test sender: delivers to the account's own address
  ) {}

  async send(x: { subject: string; text: string }): Promise<void> {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [this.to], subject: x.subject, text: x.text }),
    });
    if (!r.ok) throw new Error(`alert email ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
}
