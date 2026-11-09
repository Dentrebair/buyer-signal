"use server";
// Contact search (/contacts): only a click starts one. Server actions are public endpoints: the
// query is untrusted input, checked here and again by the table (8 to 400 characters).
import { redirect } from "next/navigation";
import { type ContactSearch, Q } from "@bs/core";
import { asOperator } from "@/lib/operator.ts";
import { queue } from "@/lib/queue.ts";

export async function findContacts(_prev: { message: string } | null, form: FormData): Promise<{ message: string }> {
  const raw = form.get("query");
  const query = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (query.length < 8) return { message: "Describe who you are and who you want, in a sentence." };
  if (query.length > 400) return { message: "Keep it under 400 characters." };
  const id = await asOperator(async (c) => (await c.query<{ id: string }>("insert into contact_searches (query) values ($1) returning id", [query])).rows[0]!.id);
  await (await queue()).send(Q.contactSearch, { searchId: id } satisfies ContactSearch);
  redirect(`/contacts?s=${id}`);
}
