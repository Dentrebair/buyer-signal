// POST /api/webhooks/apify (PRD §5.1 step 1): verify the secret header, enqueue, answer 202.
// Apify's payload carries run metadata only; the worker reads the run and its dataset.
import { timingSafeEqual } from "node:crypto";
import { ApifyRunEvent, Q } from "@bs/core";
import { queue } from "@/lib/queue.ts";

export const dynamic = "force-dynamic";

function secretMatches(given: string | null): boolean {
  const expected = process.env.APIFY_WEBHOOK_SECRET ?? "";
  if (!given || expected.length < 32) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  if (!secretMatches(req.headers.get("x-apify-webhook-secret"))) return new Response(null, { status: 401 });

  // Apify's run payload is a few KB; refuse anything large before parsing it.
  const text = await req.text();
  if (text.length > 64_000) return new Response(null, { status: 413 });
  let body: { resource?: { id?: unknown }; eventData?: { actorRunId?: unknown } };
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const parsed = ApifyRunEvent.safeParse({ apifyRunId: body.eventData?.actorRunId ?? body.resource?.id });
  if (!parsed.success) return new Response(null, { status: 400 });

  // singletonKey: a retried webhook and the poll job collapse into one job per run.
  const boss = await queue();
  await boss.send(Q.apifyRunEvent, parsed.data, { singletonKey: parsed.data.apifyRunId });
  return new Response(null, { status: 202 });
}
