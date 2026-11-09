"use client";
// The /contacts search box: who you are and who you want, in your own words.
import { useActionState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { findContacts } from "@/app/contacts/actions.ts";

export function ContactSearchForm({ initial }: { initial: string }) {
  const [state, action, pending] = useActionState(findContacts, null);
  return (
    <form action={action} className="cs-form">
      <label htmlFor="cs-query" className="cs-label">
        Who are you, and who are you looking for?
      </label>
      <div className="cs-row">
        <textarea
          id="cs-query"
          name="query"
          rows={2}
          minLength={8}
          maxLength={400}
          required
          defaultValue={initial}
          placeholder="I run an AI agency, looking for logistics businesses with manual paperwork"
          aria-describedby="cs-hint"
        />
        <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
          <MagnifyingGlass size={14} aria-hidden /> Find contacts
        </button>
      </div>
      <p id="cs-hint" className="li-cell-sub">
        For example: “I’m a logistics owner looking for people good at Facebook ads”, or “I sell freight audit software to importers”.
      </p>
      {state?.message && (
        <p className="run-result is-error" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
