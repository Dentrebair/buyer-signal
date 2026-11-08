"use client";
// AI test set (agreed 2026-11-08): the operator's own verdict on a LinkedIn post. `npm run eval`
// re-reads every labelled post and scores the AI against these labels.
import { useState, useTransition } from "react";
import { type LabelResult, labelPost } from "@/app/linkedin/actions.ts";

type Label = "lead" | "pain" | "none";
const OPTIONS: { value: Label; label: string }[] = [
  { value: "lead", label: "A lead" },
  { value: "pain", label: "Pain, not a lead" },
  { value: "none", label: "No pain" },
];

export function EvalLabel({ postId, label }: { postId: string; label: Label | null }) {
  const [current, setCurrent] = useState(label);
  const [result, setResult] = useState<LabelResult | null>(null);
  const [pending, start] = useTransition();
  const save = (next: Label | null) =>
    start(async () => {
      const before = current;
      setCurrent(next);
      const r = await labelPost(postId, next).catch((e: Error) => ({ ok: false as const, message: e.message }));
      if (!r.ok) setCurrent(before);
      setResult(r);
    });
  return (
    <div className="eval-label" role="group" aria-labelledby={`eval-${postId}`}>
      <span id={`eval-${postId}`} className="li-cell-sub">
        Your verdict, for the AI test set
      </span>
      <span className="segmented">
        {OPTIONS.map((o) => (
          <button key={o.value} type="button" aria-pressed={current === o.value} disabled={pending} onClick={() => save(current === o.value ? null : o.value)}>
            {o.label}
          </button>
        ))}
      </span>
      <p role="status" className={`run-result${result && !result.ok ? " is-error" : ""}`}>
        {result?.message ?? ""}
      </p>
    </div>
  );
}
