"use server";
// Operator actions (§10.2). The status trigger (migration 0002) sets the resurfacing fields.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { REJECT_REASONS, type Prior, type RejectReason } from "@/lib/labels.ts";
import { type DraftLlm, Q } from "@bs/core";
import { asOperator } from "@/lib/operator.ts";
import { queue } from "@/lib/queue.ts";

// Returns the state before the change, so the undo toast can put it back.
// Server actions are public endpoints: every argument is untrusted input.
const Input = z.object({
  id: z.uuid(),
  status: z.enum(["new", "actioned", "rejected"]),
  reason: z.enum(REJECT_REASONS).nullable(),
});

export async function setStatus(rawId: string, rawStatus: Prior["status"], rawReason: RejectReason | null = null): Promise<Prior> {
  const parsed = Input.safeParse({ id: rawId, status: rawStatus, reason: rawReason });
  if (!parsed.success) throw new Error("Invalid request.");
  const { id, status, reason } = parsed.data;
  if (status === "rejected" && !reason) throw new Error("Pick a rejection reason.");
  const prior = await asOperator(async (c) => {
    const before = (await c.query<Prior>("select status, rejection_reason from companies where id = $1 for update", [id])).rows[0];
    if (!before) throw new Error("Company not found.");
    await c.query("update companies set status = $2, rejection_reason = $3 where id = $1", [
      id,
      status,
      status === "rejected" ? reason : null,
    ]);
    return before;
  });
  revalidatePath("/dashboard");
  return prior;
}

// Email drafts (§9): only this click writes them. A second click while one is being written does
// nothing (one queued request per company); the worker's AI call sits inside the monthly cap.
export async function createDrafts(rawId: unknown): Promise<{ ok: boolean; message: string }> {
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return { ok: false, message: "Unknown company." };
  const requestId = await asOperator(
    async (c) =>
      (
        await c.query<{ id: string }>(
          "insert into draft_requests (company_id) values ($1) on conflict (company_id) where status = 'queued' do nothing returning id",
          [id.data],
        )
      ).rows[0]?.id ?? null,
  );
  if (!requestId) return { ok: true, message: "Already writing these drafts." };
  await (await queue()).send(Q.draftLlm, { requestId } satisfies DraftLlm);
  revalidatePath("/dashboard");
  return { ok: true, message: "Writing three drafts: about 20 seconds." };
}
