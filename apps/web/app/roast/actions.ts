"use server";
// /roast (§8): the visitor's submit. A public endpoint: every field is untrusted. Order: the
// inputs, the bot check (Turnstile), then the rate limit and daily cap (inside request_roast,
// under one lock), then the job. The site itself is only fetched by the worker, through the
// sniff's guards (DNS checked, private ranges refused, 2 MB, 8 s, 3 redirects).
import { createHmac, randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { type Roast, Q, ROAST_DAILY_CAP_DEFAULT, ROAST_PER_HOUR, emailMatchesSite, roastDomain, roastEmail } from "@bs/core";
import { asRoastVisitor } from "@/lib/operator.ts";
import { queue } from "@/lib/queue.ts";

export type RoastFormState = { message: string; url?: string; email?: string } | null;

// Visitors are rate limited by a keyed hash of their IP, never the IP itself. RATE_LIMIT_SECRET
// keeps the key across restarts; without it a restart starts every visitor's hour again.
const g = globalThis as unknown as { __bsRateKey?: string };
const rateKey = () => process.env.RATE_LIMIT_SECRET || (g.__bsRateKey ??= randomBytes(32).toString("hex"));

// Turnstile is required in production; locally it is skipped until both keys are set.
async function humanCheck(token: string, ip: string | null): Promise<string | null> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || !process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    return process.env.NODE_ENV === "production" ? "Roasts are paused while the bot check is set up." : null;
  }
  if (!token) return "Please complete the check above the button.";
  try {
    // The secret goes in the POST body, never the URL.
    const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(5000) });
    const out = (await r.json()) as { success?: boolean };
    return out.success ? null : "The check didn't pass. Try again.";
  } catch {
    return "The check couldn't be verified. Try again in a minute.";
  }
}

export async function requestRoast(_prev: RoastFormState, form: FormData): Promise<RoastFormState> {
  const text = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.slice(0, 400) : "";
  };
  const keep = { url: text("url"), email: text("email") };
  const domain = roastDomain(keep.url);
  if (!domain) return { ...keep, message: "That doesn't look like a website address. Try something like yourcompany.com." };
  const email = roastEmail(keep.email);
  if (!email) return { ...keep, message: "Enter a valid email address." };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  const failed = await humanCheck(text("cf-turnstile-response"), ip);
  if (failed) return { ...keep, message: failed };

  const cap = Math.max(1, Number(process.env.ROAST_DAILY_CAP) || ROAST_DAILY_CAP_DEFAULT);
  const bucket = `roast:${createHmac("sha256", rateKey()).update(ip ?? "unknown").digest("hex").slice(0, 32)}`;
  const r = await asRoastVisitor(
    async (c) =>
      (
        await c.query<{ id: string | null; refused: "rate" | "cap" | null }>("select id, refused from request_roast($1, $2, $3, $4, $5, $6)", [
          domain,
          email,
          emailMatchesSite(email, domain),
          bucket,
          ROAST_PER_HOUR,
          cap,
        ])
      ).rows[0]!,
  );
  if (r.refused === "rate") return { ...keep, message: "That's the most roasts for one visitor this hour. Try again later." };
  if (r.refused === "cap") return { ...keep, message: "We've hit today's limit on roasts. Try again tomorrow." };
  await (await queue()).send(Q.roast, { roastId: r.id! } satisfies Roast, { singletonKey: r.id! });
  redirect(`/roast?r=${r.id}`);
}
