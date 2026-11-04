import { describe, expect, it } from "vitest";
import { buildJobExtraction } from "@bs/core";
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

  it("refuses to start without the task's model setting", () => {
    expect(() => new OpenRouterClient({ env: { OPENROUTER_API_KEY: "k" } }).model("drafts")).toThrow(/MODEL_DRAFTS/);
  });
});
