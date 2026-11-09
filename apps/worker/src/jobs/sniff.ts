// Website sniff (§5.4): pending seeds, then one site at a time.
import {
  urgencyTier,
  Q,
  type SniffDomain,
  type VerticalSlug,
  type Country,
  websiteSignals,
  signalScore,
  weightsFor,
} from "@bs/core";
import {
  insertChallenge,
  recomputeCompanyScore,
  claimSeeds,
  finishSeed,
  saveSniff,
  seedTarget,
  withTransaction,
} from "@bs/db";
import { type Deps } from "./deps.ts";

// ── sniff-seeds: every 10 min, pending seeds → one sniff-domain job each (§4.2) ──
const SNIFF_BATCH = 20;
export async function sniffSeeds(d: Deps): Promise<number> {
  return withTransaction(d.pool, async (c) => {
    const seeds = await claimSeeds(c, SNIFF_BATCH);
    // Same transaction: a job exists only if its claim committed.
    for (const s of seeds) await d.send(Q.sniffDomain, { seedId: s.id } satisfies SniffDomain, { singletonKey: s.id }, c);
    return seeds.length;
  });
}

// ── sniff-domain: fetch + tech stack + 4-Gate, then website challenges (§5.4) ──
export async function sniffDomain(d: Deps, job: SniffDomain): Promise<string> {
  const seed = await seedTarget(d.pool, job.seedId);
  if (!seed) return "seed gone";
  if (!seed.company_id) {
    await finishSeed(d.pool, job.seedId, "failed", "no company");
    return "no company";
  }
  const companyId = seed.company_id;
  const res = await d.sniff({ domain: seed.domain, company: seed.company_name, vertical: seed.vertical as VerticalSlug | null, country: seed.country as Country | null, now: d.now() });
  if (!res.reachable) {
    await withTransaction(d.pool, async (c) => {
      await saveSniff(c, companyId, { reachable: false, audit: { unreachable: res.reason } });
      await finishSeed(c, job.seedId, "unreachable", res.reason);
    });
    return `unreachable ${seed.domain}`;
  }
  const signals = websiteSignals(res.audit, res.tech);
  await withTransaction(d.pool, async (c) => {
    await saveSniff(c, companyId, {
      reachable: true,
      clientRendered: res.audit.clientRendered,
      techStack: res.tech,
      audit: { ...res.audit, pages: res.pages },
      contactEmail: res.audit.contacts.emails[0] ?? null,
      contactWhatsapp: res.audit.contacts.whatsapp[0] ?? null,
      contactSourceUrl: res.audit.contacts.sourceUrl,
    });
    for (const sig of signals) {
      const w = weightsFor(sig.sourceType);
      await insertChallenge(c, {
        companyId,
        sourceType: sig.sourceType,
        naturalId: `site:${seed.domain}:${sig.sourceType}`,
        sourceUrl: res.finalUrl,
        E: w.E,
        I: w.I,
        B: 0, // §7: website signals carry no blast radius
        signalScore: signalScore(sig.sourceType, w, 0),
        department: "Unknown",
        postedAt: d.now(),
        evidenceSnippet: sig.evidence,
        structuredIntelligence: null,
        llmModel: null,
        urgencyTier: "low", // §1.1: website signals are passive structural debt
      });
    }
    await recomputeCompanyScore(c, companyId);
    await finishSeed(c, job.seedId, "done");
  });
  return `sniffed ${seed.domain}: ${res.tech.length} tech, ${signals.map((s) => s.sourceType).join("+") || "no website signal"}`;
}
