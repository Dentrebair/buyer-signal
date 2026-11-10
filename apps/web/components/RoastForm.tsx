"use client";
// /roast form: website + work email, and Cloudflare Turnstile when its site key is set (§8.2).
import Script from "next/script";
import { useActionState } from "react";
import { Fire } from "@phosphor-icons/react";
import { requestRoast } from "@/app/roast/actions.ts";

export function RoastForm({ siteKey }: { siteKey: string | null }) {
  const [state, action, pending] = useActionState(requestRoast, null);
  return (
    <form action={action} className="roast-form" noValidate>
      <label className="roast-field">
        <span>Your website</span>
        <input type="text" name="url" inputMode="url" autoComplete="url" placeholder="yourcompany.com" defaultValue={state?.url} required maxLength={300} />
      </label>
      <label className="roast-field">
        <span>Work email</span>
        <input type="email" name="email" autoComplete="email" placeholder="you@yourcompany.com" defaultValue={state?.email} required maxLength={254} />
      </label>
      {siteKey && (
        <>
          <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
          <div className="cf-turnstile" data-sitekey={siteKey} data-theme="auto" />
        </>
      )}
      <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
        <Fire size={16} aria-hidden /> {pending ? "Starting…" : "Roast my website"}
      </button>
      {state?.message && (
        <p className="run-result is-error" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
