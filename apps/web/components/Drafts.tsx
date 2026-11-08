"use client";
// Email drafts in the dossier (PRD §9). Nothing is written until the operator clicks Create
// drafts; opening a card never does. Three emails, the recommended one first, each with Copy.
// Copying changes nothing; sending stays outside the app.
import { useState, useTransition } from "react";
import { Check, Copy, PencilSimpleLine } from "@phosphor-icons/react";
import type { OutreachDrafts } from "@bs/core/drafts";
import { createDrafts } from "@/app/dashboard/actions.ts";
import type { Company } from "@/lib/inbox.ts";
import { AutoRefresh } from "./RunNow.tsx";

const STRATEGY: Record<string, string> = {
  direct_active_intent: "Direct",
  peer_benchmark_question: "Peer question",
  educational_value_first: "Value first",
};

export function Drafts({ c }: { c: Pick<Company, "id" | "outreach_drafts" | "draft_stale" | "draft_generated_at" | "draft_request"> }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const writing = c.draft_request?.status === "queued";
  const failed = c.draft_request?.status === "error" ? c.draft_request.error : null;
  const drafts = c.outreach_drafts;
  const create = () =>
    start(async () => {
      const r = await createDrafts(c.id).catch((e: Error) => ({ ok: false, message: e.message }));
      setMessage(r.message);
    });
  const button = (label: string) => (
    <button type="button" className={`btn${drafts ? "" : " primary"}`} onClick={create} disabled={pending || writing} aria-busy={pending || writing}>
      <PencilSimpleLine size={14} aria-hidden /> {writing ? "Writing drafts…" : label}
    </button>
  );
  return (
    <div className="drafts">
      <AutoRefresh active={writing} />
      {!drafts && !writing && (
        <p className="muted drafts-note">Three short emails, each a different approach, written by AI from this company&apos;s evidence. About $0.02. Nothing is sent.</p>
      )}
      {writing && <p className="muted drafts-note" role="status">Writing three drafts from the evidence: usually under 30 seconds.</p>}
      {failed && !writing && <p className="run-result is-error">Couldn&apos;t write the drafts: {failed}. Try again.</p>}
      {drafts && c.draft_stale && !writing && <p className="drafts-stale">New evidence has arrived since these were written. Regenerate to include it.</p>}
      {drafts && drafts.warning_banner && <p className="drafts-warning">{drafts.warning_banner}</p>}
      <div className="run">
        {button(drafts ? "Regenerate drafts" : "Create email drafts")}
        {message && !writing && <span className="muted drafts-note">{message}</span>}
      </div>
      {drafts && (
        <ol className="drafts-list">
          {[...drafts.emails]
            .sort((a, b) => Number(b.strategy === drafts.recommended) - Number(a.strategy === drafts.recommended))
            .map((e) => (
              <li key={e.strategy} className={`draft${e.strategy === drafts.recommended ? " is-recommended" : ""}`}>
                <div className="lead-head">
                  <span className="verdict">{STRATEGY[e.strategy] ?? e.strategy}</span>
                  {e.strategy === drafts.recommended && <span className="verdict verdict-green">Recommended</span>}
                  <CopyButton text={`Subject: ${e.subject}\n\n${e.body}`} label={`Copy the ${STRATEGY[e.strategy] ?? e.strategy} email`} />
                </div>
                {e.strategy === drafts.recommended && <p className="li-cell-sub">{drafts.why}</p>}
                <p className="draft-subject">{e.subject}</p>
                <p className="draft-body">{e.body}</p>
              </li>
            ))}
        </ol>
      )}
      {drafts && c.draft_generated_at && (
        <p className="li-cell-sub">
          Written {new Date(c.draft_generated_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
          {c.draft_request?.status === "done" && c.draft_request.model && ` by ${c.draft_request.model}`}
          {c.draft_request?.status === "done" && c.draft_request.cost_usd !== null && `, $${c.draft_request.cost_usd.toFixed(4)}`}
        </p>
      )}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm draft-copy"
      aria-label={label}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => (setCopied(true), setTimeout(() => setCopied(false), 2000)),
          () => setCopied(false),
        )
      }
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? "Copied" : "Copy"}
    </button>
  );
}
