"use server";
// AI test set (agreed 2026-11-08): the operator labels a LinkedIn post; `npm run eval` scores the
// AI against the labels. Server actions are public endpoints: every argument is untrusted input.
import { revalidatePath } from "next/cache";
import { labelLiPost } from "@bs/db";
import { asOperator } from "@/lib/operator.ts";

export type LabelResult = { ok: true; message: string } | { ok: false; message: string };
const LABELS = ["lead", "pain", "none"] as const;

export async function labelPost(id: unknown, label: unknown): Promise<LabelResult> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return { ok: false, message: "Unknown post." };
  if (label !== null && !LABELS.includes(label as (typeof LABELS)[number])) return { ok: false, message: "Unknown label." };
  const done = await asOperator((c) => labelLiPost(c, id, label as (typeof LABELS)[number] | null));
  revalidatePath("/linkedin");
  if (!done) return { ok: false, message: label === null ? "It was not in the test set." : "That post is gone." };
  return { ok: true, message: label === null ? "Removed from the test set." : "Saved to the test set." };
}
