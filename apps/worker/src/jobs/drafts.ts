// Email drafts on the operator's click (§9).
import {
  type DraftLlm,
  buildDraft,
  mergeDraft,
  recommendStrategy,
} from "@bs/core";
import {
  draftInput,
  draftRequest,
  failDraft,
  saveDrafts,
  withTransaction,
} from "@bs/db";
import { type Deps } from "./deps.ts";

// ── draft-llm (§9): only from the operator's click ──────────────────────────
// One email per click: the approach the request names, else the recommended one, which the code
// picks from the evidence. Merged into the company's drafts (one per approach, at most three).
// Inside the monthly AI cap like every call. A final AI failure is recorded so the button can retry.
export async function draftLlm(d: Pick<Deps, "pool" | "llm" | "log">, job: DraftLlm): Promise<string> {
  const req = await draftRequest(d.pool, job.requestId);
  if (!req) return "request gone";
  if (req.status !== "queued") return "already done";
  const company = await draftInput(d.pool, req.companyId);
  if (!company) {
    await failDraft(d.pool, req.id, "Company not found");
    return "company gone";
  }
  const pick = recommendStrategy(company.evidence);
  const strategy = req.strategy ?? pick.strategy;
  const out = await d.llm.json("drafts", buildDraft(company, strategy)).catch(async (e: unknown) => {
    if ((e as { retryable?: unknown }).retryable === false) await failDraft(d.pool, req.id, (e as Error).message);
    throw e;
  });
  const email = { strategy, subject: out.data.subject, body: out.data.body, written_at: new Date().toISOString() };
  const drafts = mergeDraft(req.drafts, email, out.data.warning_banner, pick);
  // Fresh again only when nothing older than the new evidence is left: a lone first email, or a
  // rewrite that leaves no other email behind.
  const fresh = drafts.emails.length === 1;
  await withTransaction(d.pool, (c) => saveDrafts(c, { requestId: req.id, companyId: req.companyId, drafts, fresh, model: out.model, costUsd: out.costUsd }));
  return `${strategy} email for ${company.name} ($${out.costUsd.toFixed(4)})`;
}
