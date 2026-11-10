// /roast job against the real database with a fake sniff and a fake AI (no spend, no fetch).
// Skipped without DATABASE_URL. Every row it writes is removed.
import { afterAll, describe, expect, it } from "vitest";
import type { LlmClient, SiteAudit } from "@bs/core";
import { createPool } from "@bs/db";
import type { SniffResult } from "@bs/integrations";
import { roastJob } from "../src/jobs.ts";

const DOMAIN = "roast-test.example";
const url = process.env.DATABASE_URL;
const pool = url ? createPool(2) : null;
const clean = async () => {
  await pool?.query("delete from roast_requests where domain = $1", [DOMAIN]);
  await pool?.query("delete from companies where domain = $1", [DOMAIN]);
};
afterAll(async () => {
  await clean();
  await pool?.end();
});

const audit: SiteAudit = {
  clientRendered: false,
  gate1: { dependsOnWebsite: true, reasons: [], serviceWords: 400 },
  gate2: { tableLayout: false, missingViewport: false, copyrightYear: 2026, staleCopyright: false, wallOfText: false, legacyLibs: [] },
  gate3: { maxFormFields: 4, longForm: false, noAboveFoldCta: false, noSocialProof: false, noJsonLd: false, aiBotsBlocked: [], noLlmsTxt: false },
  gate4: null,
  pain: { pdfForms: [{ url: `https://${DOMAIN}/intake.pdf`, label: "Patient intake form" }], mailtoOnly: true, noScheduling: null },
  contacts: { emails: [`hello@${DOMAIN}`], whatsapp: [], phones: [], sourceUrl: null },
};

describe.skipIf(!url)("roast", () => {
  it("saves the lead first, then the teardown; verified resurfaces, unverified never does; unreachable still saves the lead", async () => {
    await clean();
    const prompts: string[] = [];
    let reachable = true;
    const d = {
      pool: pool!,
      now: () => new Date(),
      log: () => {},
      sniff: async (): Promise<SniffResult> =>
        reachable ? { reachable: true, finalUrl: `https://${DOMAIN}/`, pages: [`https://${DOMAIN}/`], tech: [], audit } : { reachable: false, reason: "no HTML response" },
      llm: {
        worstCaseUsd: async () => 0.01,
        json: async (task, req) => {
          expect(task).toBe("roast");
          prompts.push(req.user);
          return { data: req.parse({ headline: "Your intake runs on paper", summary: "S", findings: [{ title: "PDF intake", detail: "D", fix: "F" }], quick_win: "Q" }) as any, model: "fake/writer", costUsd: 0.02 };
        },
      } satisfies LlmClient,
    };
    const ask = async (email: string, verified: boolean) =>
      (await pool!.query<{ id: string }>("insert into roast_requests (domain, email, email_verified) values ($1, $2, $3) returning id", [DOMAIN, email, verified])).rows[0]!.id;
    const company = async () =>
      (await pool!.query("select c.status, c.priority_score, array_agg(ch.source_type order by ch.source_type) types, bool_or(ch.inbound_verified) verified from companies c join challenges ch on ch.company_id = c.id where c.domain = $1 group by c.id", [DOMAIN])).rows[0];

    const first = await ask(`jo@${DOMAIN}`, true);
    expect(await roastJob(d, { roastId: first })).toMatch(/roasted roast-test.example \(verified/);
    expect(await company()).toMatchObject({ status: "new", priority_score: 100, types: ["dom_sniff", "inbound"], verified: true });
    const done = (await pool!.query("select status, teardown, company_id, cost_usd::float8 cost from roast_requests where id = $1", [first])).rows[0];
    expect(done).toMatchObject({ status: "done", teardown: { headline: "Your intake runs on paper" }, cost: 0.02 });
    expect(done.company_id).toBeTruthy();
    expect(prompts[0]).toContain("Patient intake form");
    expect(prompts[0]).not.toContain("jo@"); // the visitor's email never reaches the AI
    expect(await roastJob(d, { roastId: first })).toBe("already done");

    await pool!.query("update companies set status = 'actioned' where domain = $1", [DOMAIN]);
    await roastJob(d, { roastId: await ask("jo@gmail.com", false) });
    expect((await company()).status).toBe("actioned");
    await roastJob(d, { roastId: await ask(`ceo@${DOMAIN}`, true) });
    expect((await company()).status).toBe("new");

    reachable = false;
    const down = await ask(`jo@${DOMAIN}`, true);
    expect(await roastJob(d, { roastId: down })).toBe("unreachable roast-test.example");
    const r = (await pool!.query("select status, error, company_id from roast_requests where id = $1", [down])).rows[0];
    expect(r).toMatchObject({ status: "error", error: expect.stringMatching(/couldn't read roast-test.example/) });
    expect(r.company_id).toBeTruthy();
    expect(prompts).toHaveLength(3);
  }, 60_000);
});
