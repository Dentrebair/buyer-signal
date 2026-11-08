"use client";
// Email drafts in the dossier (PRD §9). Nothing is written until the operator clicks. One click,
// one email (operator's choice, 2026-11-08): the first in the recommended approach, then, if
// wanted, one each in the other two, at most three. Each has Copy and Rewrite. Nothing is sent.
import { useState, useTransition } from "react";
import { ArrowsClockwise, Check, Copy, PencilSimpleLine, Plus } from "@phosphor-icons/react";
import type { OutreachStrategy } from "@bs/core/drafts";
import { createDrafts } from "@/app/dashboard/actions.ts";
import type { Company } from "@/lib/inbox.ts";
import { AutoRefresh } from "./RunNow.tsx";

const STRATEGIES: OutreachStrategy[] = ["direct_active_intent", "peer_benchmark_question", "educational_value_first"];
const LABEL: Record<OutreachStrategy, string> = {
  direct_active_intent: "Direct",
  peer_benchmark_question: "Peer question",
  educational_value_first: "Value first",
};
const HINT: Record<OutreachStrategy, string> = {
  direct_active_intent: "connects their need to the fix",
  peer_benchmark_question: "asks how they handle the work today",
  educational_value_first: "gives one useful idea first",
};

type DraftsProps = Pick<Company, "id" | "outreach_drafts" | "draft_request" | "challenges">;

export function Drafts({ c }: { c: DraftsProps }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const writing = c.draft_request?.status === "queued";
  const failed = c.draft_request?.status === "error" ? c.draft_request.error : null;
  const drafts = c.outreach_drafts;
  const emails = drafts?.emails ?? [];
  const missing = STRATEGIES.filter((s) => !emails.some((e) => e.strategy === s));
  // An email written before the latest evidence arrived is marked so it can be rewritten.
  const newest = Math.max(0, ...c.challenges.map((ch) => Date.parse(ch.created_at)));
  const stale = (written?: string) => !!written && Date.parse(written) < newest;
  const write = (strategy: OutreachStrategy | null) =>
    start(async () => {
      const r = await createDrafts(c.id, strategy).catch((e: Error) => ({ ok: false, message: e.message }));
      setMessage(r.message);
    });
  const busy = pending || writing;

  return (
    <div className="drafts">
      <AutoRefresh active={writing} />
      {!emails.length && !writing && (
        <>
          <p className="muted drafts-note">One short email written by AI from this company&apos;s evidence, in the approach that fits it best. You can add up to two more approaches after. Nothing is sent.</p>
          <div className="run">
            <button type="button" className="btn primary" onClick={() => write(null)} disabled={busy} aria-busy={busy}>
              <PencilSimpleLine size={14} aria-hidden /> Create email draft
            </button>
          </div>
        </>
      )}
      {writing && <p className="muted drafts-note" role="status">Writing the email from the evidence: usually under 20 seconds.</p>}
      {failed && !writing && <p className="run-result is-error">Couldn&apos;t write the email: {failed}. Try again.</p>}
      {message && !writing && !failed && <p className="muted drafts-note">{message}</p>}
      {drafts?.warning_banner && <p className="drafts-warning">{drafts.warning_banner}</p>}

      {emails.length > 0 && (
        <ol className="drafts-list">
          {[...emails]
            .sort((a, b) => Number(b.strategy === drafts!.recommended) - Number(a.strategy === drafts!.recommended))
            .map((e) => (
              <li key={e.strategy} className={`draft${e.strategy === drafts!.recommended ? " is-recommended" : ""}`}>
                <div className="lead-head">
                  <span className="verdict">{LABEL[e.strategy]}</span>
                  {e.strategy === drafts!.recommended && <span className="verdict verdict-green">Recommended</span>}
                  <span className="draft-tools">
                    <button type="button" className="btn btn-sm" onClick={() => write(e.strategy)} disabled={busy} aria-label={`Rewrite the ${LABEL[e.strategy]} email`}>
                      <ArrowsClockwise size={14} aria-hidden /> Rewrite
                    </button>
                    <CopyButton text={`Subject: ${e.subject}\n\n${e.body}`} label={`Copy the ${LABEL[e.strategy]} email`} />
                  </span>
                </div>
                {e.strategy === drafts!.recommended && <p className="li-cell-sub">{drafts!.why}</p>}
                {stale(e.written_at) && <p className="drafts-stale">Written before new evidence arrived. Rewrite to include it.</p>}
                <p className="draft-subject">{e.subject}</p>
                <p className="draft-body">{e.body}</p>
              </li>
            ))}
        </ol>
      )}

      {emails.length > 0 && missing.length > 0 && (
        <div className="drafts-more" role="group" aria-label="Write another approach">
          <span className="li-cell-sub">Another approach, if you want one ({missing.length} left):</span>
          {missing.map((s) => (
            <button key={s} type="button" className="btn btn-sm" onClick={() => write(s)} disabled={busy} aria-busy={busy}>
              <Plus size={14} aria-hidden /> {LABEL[s]}: {HINT[s]}
            </button>
          ))}
        </div>
      )}

      {emails.length > 0 && c.draft_request?.status === "done" && c.draft_request.model && (
        <p className="li-cell-sub">
          Last written by {c.draft_request.model}
          {c.draft_request.cost_usd !== null && `, $${c.draft_request.cost_usd.toFixed(4)}`}
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
      className="btn btn-sm"
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
