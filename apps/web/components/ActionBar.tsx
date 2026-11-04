"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowCounterClockwise, PaperPlaneTilt, X } from "@phosphor-icons/react";
import { setStatus } from "@/app/dashboard/actions.ts";
import { REJECT_LABEL, REJECT_REASONS, type RejectReason } from "@/lib/labels.ts";
import { useToast } from "./Toast.tsx";

interface Props {
  id: string;
  domain: string; // display name used in the toast
  status: "new" | "actioned" | "rejected";
  nextHref: string; // the company that opens after an action (§10.1)
  selfHref: string; // where undo returns to
}

export function ActionBar({ id, domain, status, nextHref, selfHref }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState<RejectReason | "">("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"sent" | "reject" | "restore" | null>(null);
  const [, start] = useTransition();

  const act = (to: "new" | "actioned" | "rejected", label: typeof busy, message: string) => {
    setBusy(label);
    setError(null);
    start(async () => {
      try {
        const prior = await setStatus(id, to, to === "rejected" ? (reason as RejectReason) : null);
        setReason("");
        router.push(nextHref, { scroll: false });
        toast({
          message,
          undo: async () => {
            await setStatus(id, prior.status, prior.rejection_reason);
            router.push(selfHref, { scroll: false });
          },
        });
      } catch (e) {
        setError(`Couldn't save: ${(e as Error).message} Try again.`);
      } finally {
        setBusy(null);
      }
    });
  };

  return (
    <div className="action-bar">
      {status === "new" ? (
        <>
          <button type="button" className="btn primary" disabled={busy !== null} onClick={() => act("actioned", "sent", `${domain} marked as sent`)}>
            <PaperPlaneTilt size={16} aria-hidden /> {busy === "sent" ? "Saving…" : "Mark as sent"}
          </button>
          <div className="reject-group">
            <label className="sr-only" htmlFor="reject-reason">
              Rejection reason
            </label>
            <select id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value as RejectReason | "")} disabled={busy !== null}>
              <option value="">Reason to reject…</option>
              {REJECT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {REJECT_LABEL[r]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn danger"
              disabled={busy !== null || !reason}
              title={reason ? undefined : "Pick a reason first"}
              onClick={() => act("rejected", "reject", `${domain} rejected`)}
            >
              <X size={16} aria-hidden /> {busy === "reject" ? "Saving…" : "Reject"}
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="btn" disabled={busy !== null} onClick={() => act("new", "restore", `${domain} moved back to the inbox`)}>
          <ArrowCounterClockwise size={16} aria-hidden /> {busy === "restore" ? "Saving…" : "Move back to inbox"}
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
