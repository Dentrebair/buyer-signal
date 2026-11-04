import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApifyClient, INDEED_PRICES, mapIndeedItem, runCostUsd } from "../src/index.ts";

// Real item from the 2026-11-03 Sprint 0 run (scrubbed) + one with employer fields filled.
const items = JSON.parse(readFileSync(new URL("./fixtures/indeed-items.json", import.meta.url), "utf8"));

describe("Indeed mapping (verified fields)", () => {
  it("maps the real item; missing employer name stays null", () => {
    const p = mapIndeedItem(items[0], "us")!;
    expect(p).toMatchObject({ naturalId: "job:indeed:d5eb758b439a25d5", company: null, city: "Manchester", country: "us", boardWebsite: null });
    expect(p.postedAt?.toISOString()).toBe("2026-10-29T15:03:17.463Z");
    expect(p.description.length).toBeGreaterThan(100);
  });

  it("reads website and size band, never personal fields", () => {
    const p = mapIndeedItem(items[1], "us")!;
    expect(p).toMatchObject({ company: "Acme Freight LLC", boardWebsite: "http://www.acme-freight.example", boardEmployeeBand: "11 to 50" });
    expect(JSON.stringify(p)).not.toContain("[removed]");
  });

  it("rejects items without key, url or title, and non-http links", () => {
    expect(mapIndeedItem({ title: "x" }, "us")).toBeNull();
    expect(mapIndeedItem({ ...items[1], url: "javascript:alert(1)" }, "us")).toBeNull();
  });
});

describe("ApifyClient", () => {
  it("token in header, caps in query, no webhook or secret in the URL", async () => {
    let url = "";
    let init: RequestInit = {};
    const f = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return new Response(JSON.stringify({ data: { id: "run1", status: "READY", defaultDatasetId: "ds1", chargedEventCounts: null, startedAt: "" } }));
    }) as unknown as typeof fetch;
    const run = await new ApifyClient({ token: "tok", fetch: f }).startRun("valig/indeed-jobs-scraper", { title: "x" }, {
      maxItems: 10,
      maxTotalChargeUsd: 0.012,
    });
    expect(run.id).toBe("run1");
    expect(url).toContain("/acts/valig~indeed-jobs-scraper/runs?");
    expect(url).not.toContain("tok");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const q = new URL(url).searchParams;
    expect(q.get("maxItems")).toBe("10");
    expect(q.get("maxTotalChargeUsd")).toBe("0.0120");
    expect(q.has("webhooks")).toBe(false);
  });

  it("persistent webhook: secret only in the JSON body, idempotent key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (u: string, i: RequestInit) => {
      calls.push({ url: u, init: i });
      return new Response(JSON.stringify({ data: { id: calls.length === 1 ? "ACTOR123" : "hook1" } }));
    }) as unknown as typeof fetch;
    const secret = "s".repeat(64);
    await new ApifyClient({ token: "tok", fetch: f }).ensureWebhook({ actor: "valig/indeed-jobs-scraper", url: "https://app.example/api/webhooks/apify", secret, idempotencyKey: "k1" });
    const post = calls[1]!;
    expect(post.url).toMatch(/\/webhooks$/);
    expect(calls.every((c) => !c.url.includes(secret))).toBe(true);
    const body = JSON.parse(post.init.body as string);
    expect(body).toMatchObject({ condition: { actorId: "ACTOR123" }, idempotencyKey: "k1" });
    expect(JSON.parse(body.headersTemplate)["X-Apify-Webhook-Secret"]).toBe(secret);
  });

  it("exact run cost from charged events (verified run: 25 items + start = $0.0035)", () => {
    expect(runCostUsd({ chargedEventCounts: { "apify-default-dataset-item": 25, "apify-actor-start": 1 } }, INDEED_PRICES)).toBeCloseTo(0.0035, 6);
  });
});
