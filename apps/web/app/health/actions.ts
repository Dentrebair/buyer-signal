"use server";
// Leak check proposals (§6.3 step 6): the operator approves a phrase into the keyword trie, or
// rejects it with a reason. RLS lets the operator move a proposal from proposed to approved or
// rejected only; the database records the evidence the decision was made on.
import { revalidatePath } from "next/cache";
import { asOperator } from "@/lib/operator.ts";

export type DecideResult = { ok: true; message: string } | { ok: false; message: string };

export async function decideProposal(id: unknown, decision: unknown, reason: unknown): Promise<DecideResult> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return { ok: false, message: "Unknown proposal." };
  if (decision !== "approved" && decision !== "rejected") return { ok: false, message: "Unknown decision." };
  const why = typeof reason === "string" ? reason.trim().slice(0, 200) || null : null;
  const n = await asOperator(
    async (c) => (await c.query("update trie_proposals set status = $2, reason = $3 where id = $1 and status = 'proposed'", [id, decision, why])).rowCount ?? 0,
  );
  revalidatePath("/health");
  if (!n) return { ok: false, message: "Already decided." };
  return { ok: true, message: decision === "approved" ? "Approved: the keyword filter uses it within a minute." : "Rejected: it comes back only if its evidence doubles." };
}
