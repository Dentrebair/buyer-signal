"use server";
// Operator actions (§10.2). The status trigger (migration 0002) sets the resurfacing fields.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { REJECT_REASONS, type Prior, type RejectReason } from "@/lib/labels.ts";
import { asOperator } from "@/lib/operator.ts";

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
