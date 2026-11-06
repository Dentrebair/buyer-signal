"use server";
// Run now (§10.3): enqueue the same jobs the crons would. The worker's budget gates still apply,
// so a click past the Apify cycle cap or the daily search quota is deferred, not run.
import { revalidatePath } from "next/cache";
import { Q, StartBoardRun } from "@bs/core";
import { asOperator } from "@/lib/operator.ts";
import { queue } from "@/lib/queue.ts";

export type RunResult = { ok: true; message: string } | { ok: false; message: string };

// Server actions are public endpoints: every argument is untrusted input.
export async function runJobPosts(raw: unknown): Promise<RunResult> {
  const parsed = StartBoardRun.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Check the vertical, market, title and number of posts." };
  await asOperator(async () => {}); // localhost-only guard, as for every inbox action
  await (await queue()).send(Q.startBoardRun, parsed.data);
  revalidatePath("/radar");
  return { ok: true, message: `Started: ${parsed.data.limit} × "${parsed.data.title}". New cards appear in the inbox in a few minutes.` };
}

export async function runSource(source: "sniff" | "search"): Promise<RunResult> {
  if (source !== "sniff" && source !== "search") return { ok: false, message: "Unknown source." };
  await asOperator(async () => {});
  await (await queue()).send(source === "sniff" ? Q.sniffSeeds : Q.resolveBatch, {});
  revalidatePath("/radar");
  return {
    ok: true,
    message: source === "sniff" ? "Website check started for waiting sites." : "Website search started, within today's search quota.",
  };
}
