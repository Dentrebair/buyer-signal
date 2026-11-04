"use server";
// Operator actions (§10.2). The status trigger (migration 0002) sets the resurfacing fields.
import { revalidatePath } from "next/cache";
import { REJECT_REASONS, type Prior, type RejectReason } from "@/lib/labels.ts";
import { asOperator } from "@/lib/operator.ts";

// Returns the state before the change, so the undo toast can put it back.
export async function setStatus(id: string, status: Prior["status"], reason: RejectReason | null = null): Promise<Prior> {
  if (status === "rejected" && (!reason || !REJECT_REASONS.includes(reason))) throw new Error("Pick a rejection reason.");
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
