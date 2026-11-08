"use client";
// Approve or reject one leak-check phrase (§6.3 step 6). A reason is optional on reject.
import { useState, useTransition } from "react";
import { type DecideResult, decideProposal } from "@/app/health/actions.ts";

export function ProposalActions({ id, phrase }: { id: string; phrase: string }) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<DecideResult | null>(null);
  const [pending, start] = useTransition();
  const decide = (decision: "approved" | "rejected") =>
    start(async () => setResult(await decideProposal(id, decision, reason).catch((e: Error) => ({ ok: false as const, message: e.message }))));
  if (result?.ok) return <p role="status" className="run-result">{result.message}</p>;
  return (
    <div className="proposal-actions">
      <button type="button" className="btn btn-sm primary" disabled={pending} aria-busy={pending} onClick={() => decide("approved")} aria-label={`Approve “${phrase}”`}>
        Approve
      </button>
      <label className="field field-inline">
        <span className="sr-only">Reason for rejecting “{phrase}” (optional)</span>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Reason (optional)" />
      </label>
      <button type="button" className="btn btn-sm" disabled={pending} onClick={() => decide("rejected")} aria-label={`Reject “${phrase}”`}>
        Reject
      </button>
      <p role="status" className={`run-result${result && !result.ok ? " is-error" : ""}`}>
        {result?.message ?? ""}
      </p>
    </div>
  );
}
