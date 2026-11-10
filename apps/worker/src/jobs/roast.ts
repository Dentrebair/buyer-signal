// /roast, "Roast My Stack" (§8): one visitor's request.
import { type Roast, buildRoast, signalScore, weightsFor } from "@bs/core";
import { finishRoast, insertChallenge, linkRoastCompany, recomputeCompanyScore, resurfaceVerifiedInbound, roastRequest, saveSniff, upsertCompany, withTransaction } from "@bs/db";
import { type Deps } from "./deps.ts";
import { saveSiteSniff } from "./sniff.ts";

// ── roast: sniff the site ($0), save the lead, then the AI teardown ─────────
// The lead is saved first and on its own, so a failed teardown never loses an inbound: the
// company (upserted on its domain) with the sniff's website challenges and an `inbound` challenge
// (score 100, §7). Verified (email on the site's domain) brings it back to the inbox if it was
// actioned or rejected; unverified never does. The teardown goes through the monthly AI cap.
export async function roastJob(d: Pick<Deps, "pool" | "llm" | "sniff" | "now" | "log">, job: Roast): Promise<string> {
  const r = await roastRequest(d.pool, job.roastId);
  if (!r) return "roast gone";
  if (r.status !== "queued") return "already done";
  const res = await d.sniff({ domain: r.domain, company: null, vertical: null, country: null, now: d.now() });
  await withTransaction(d.pool, async (c) => {
    const companyId = await upsertCompany(c, { domain: r.domain, companyName: null, vertical: null, country: null, employeeBand: null, sizeTier: "unknown", sizeSource: "none" });
    if (res.reachable) await saveSiteSniff(c, d.now(), companyId, r.domain, res);
    else await saveSniff(c, companyId, { reachable: false, audit: { unreachable: res.reason } });
    const w = weightsFor("inbound");
    await insertChallenge(c, {
      companyId,
      sourceType: "inbound",
      naturalId: `inbound:roast:${r.id}`,
      sourceUrl: res.reachable ? res.finalUrl : `https://${r.domain}/`,
      E: w.E,
      I: w.I,
      B: 0,
      signalScore: signalScore("inbound", w, 0),
      department: "Unknown",
      postedAt: d.now(),
      evidenceSnippet: `Asked for a website roast through /roast from ${r.email} (${r.email_verified ? "email on the site's domain" : "unverified: free mail or another domain"}).`,
      structuredIntelligence: null,
      llmModel: null,
      inboundVerified: r.email_verified,
      urgencyTier: "high",
    });
    if (r.email_verified) await resurfaceVerifiedInbound(c, companyId);
    await recomputeCompanyScore(c, companyId);
    await linkRoastCompany(c, r.id, companyId);
  });
  if (!res.reachable) {
    await finishRoast(d.pool, { id: r.id, teardown: null, error: `We couldn't read ${r.domain}: ${res.reason}`, model: null, costUsd: 0 });
    return `unreachable ${r.domain}`;
  }
  const out = await d.llm.json("roast", buildRoast({ domain: r.domain, audit: res.audit, tech: res.tech })).catch(async (e: unknown) => {
    if ((e as { retryable?: unknown }).retryable === false) await finishRoast(d.pool, { id: r.id, teardown: null, error: "The teardown couldn't be written", model: null, costUsd: 0 });
    throw e;
  });
  await finishRoast(d.pool, { id: r.id, teardown: out.data, error: null, model: out.model, costUsd: out.costUsd });
  return `roasted ${r.domain} (${r.email_verified ? "verified" : "unverified"}, $${out.costUsd.toFixed(4)})`;
}
