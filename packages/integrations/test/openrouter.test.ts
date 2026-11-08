import { describe, expect, it } from "vitest";
import { buildJobExtraction, buildResolve } from "@bs/core";
import { OpenRouterClient, ProviderError } from "../src/index.ts";

const env = { OPENROUTER_API_KEY: "test-key", MODEL_EXTRACTION: "anthropic/claude-haiku-5.5" };
const req = buildJobExtraction({ title: "t", company: "c", location: null, description: "d" });
const reply = {
  department: "Finance",
  verified_symptom: "s",
  inferred_tech_stack: [],
  automatable_task_percentage: null,
  proposed_ai_replacement: null,
  blast_radius: { frequency: "Weekly", urgency_level: "Nuisance", founder_dependency_flag: false, estimated_hours_wasted_weekly: 5 },
  automation_fit: "some",
  known_large_brand: false,
  author_relation: null,
  stance: null,
};

const completion = (content: unknown, cost = 0.001) =>
  new Response(JSON.stringify({ model: env.MODEL_EXTRACTION, choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost } }));

function fakeFetch(responses: (Response | Error)[]) {
  const calls: RequestInit[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("OpenRouterClient", () => {
  it("sends the key in the header, never the URL, and returns parsed data with cost", async () => {
    const { f, calls } = fakeFetch([completion(reply)]);
    const out = await new OpenRouterClient({ env, fetch: f }).json("extraction", req);
    expect(out).toMatchObject({ model: env.MODEL_EXTRACTION, costUsd: 0.001, data: { department: "Finance" } });
    expect((calls[0]!.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(calls[0]!.body as string).response_format.json_schema.strict).toBe(true);
  });

  it("retries invalid output once, then fails non-retryably with the cost spent", async () => {
    const bad = { ...reply, automation_fit: "maybe" };
    const { f } = fakeFetch([completion(bad), completion(bad)]);
    const err = await new OpenRouterClient({ env, fetch: f }).json("extraction", req).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.costUsd).toBeCloseTo(0.002);
  });

  it("retries 5xx and network errors, not 4xx", async () => {
    const ok = fakeFetch([new Response("down", { status: 503 }), new Error("socket hang up"), completion(reply)]);
    await expect(new OpenRouterClient({ env, fetch: ok.f, retryDelaysMs: [0, 0, 0] }).json("extraction", req)).resolves.toBeTruthy();

    const bad = fakeFetch([new Response("bad key", { status: 401 }), completion(reply)]);
    await expect(new OpenRouterClient({ env, fetch: bad.f, retryDelaysMs: [0, 0, 0] }).json("extraction", req)).rejects.toThrow(/401/);
  });

  it("web search: sends the web plugin and returns the cited URLs", async () => {
    const res = new Response(
      JSON.stringify({
        model: env.MODEL_EXTRACTION,
        choices: [{ message: { content: JSON.stringify({ domain: "acme.com", confidence: "high" }), annotations: [{ type: "url_citation", url_citation: { url: "https://www.acme.com/about" } }] } }],
        usage: { cost: 0.0015 },
      }),
    );
    const { f, calls } = fakeFetch([res]);
    const out = await new OpenRouterClient({ env, fetch: f }).json("resolve", buildResolve({ company: "Acme", city: "Dubai", country: "ae" }));
    expect(out.citations).toEqual(["https://www.acme.com/about"]);
    expect(JSON.parse(calls[0]!.body as string).plugins).toEqual([{ id: "web", engine: "parallel", mode: "fast", max_results: 10 }]);
    // Plain calls send no plugin.
    const plain = fakeFetch([completion(reply)]);
    await new OpenRouterClient({ env, fetch: plain.f }).json("extraction", req);
    expect(JSON.parse(plain.calls[0]!.body as string).plugins).toBeUndefined();
  });

  it("refuses to start without the task's model setting, unless the task has a default", () => {
    expect(() => new OpenRouterClient({ env: { OPENROUTER_API_KEY: "k" } }).model("roast")).toThrow(/MODEL_ROAST/);
    // Drafts (§9) default to a strong writer; MODEL_DRAFTS overrides it.
    expect(new OpenRouterClient({ env: { OPENROUTER_API_KEY: "k" } }).model("drafts")).toBe("anthropic/claude-sonnet-5.5");
    expect(new OpenRouterClient({ env: { OPENROUTER_API_KEY: "k", MODEL_DRAFTS: "google/gemini-3.1-pro-preview" } }).model("drafts")).toBe("google/gemini-3.1-pro-preview");
  });
});
