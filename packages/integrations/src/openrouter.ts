// OpenRouter implementation of LlmClient (PRD §5.3: one wrapper — task → model setting,
// structured JSON output, Zod validation, provider-reported cost).
import type { LlmCallResult, LlmClient, LlmRequest, LlmTask } from "@bs/core";

const BASE = "https://openrouter.ai/api/v1";
const MODEL_ENV: Record<LlmTask, string> = {
  extraction: "MODEL_EXTRACTION",
  resolve: "MODEL_EXTRACTION",
  drafts: "MODEL_DRAFTS",
  roast: "MODEL_ROAST",
};

// A task with no model set falls back here. Drafts (§9, operator's choice 2026-11-08): OpenRouter's
// Auto Router picks the model for each request; the model it chose is recorded with the draft.
const DEFAULT_MODEL: Partial<Record<LlmTask, string>> = { drafts: "openrouter/auto" };
// A router's price is listed as -1 (it depends on the model it picks). The budget gate's worst
// case then assumes the dearest model it could pick: Claude Opus 5, $5 / $25 per million tokens
// (2026-11-08). What is spent is the cost OpenRouter reports for the call.
const ROUTER_CEILING: Pricing = { prompt: 5e-6, completion: 25e-6 };

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface OpenRouterOptions {
  apiKey?: string;
  env?: Record<string, string | undefined>;
  maxTokens?: number;
  timeoutMs?: number;
  retryDelaysMs?: number[]; // §5.3a: 30 s → 2 min → 8 min
  fetch?: typeof fetch;
}

// Web search (Q62): Parallel engine, fast mode — $0.001 per request for up to 10 results; the
// results are also billed as prompt tokens. ~1,500 tokens per result is a safe overestimate.
const SEARCH_FEE_USD = 0.001;
const SEARCH_TOKENS_PER_RESULT = 1500;

interface Pricing {
  prompt: number;
  completion: number;
}

export class OpenRouterClient implements LlmClient {
  private readonly apiKey: string;
  private readonly env: Record<string, string | undefined>;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly fetch: typeof fetch;
  private pricing: Promise<Map<string, Pricing>> | null = null;

  constructor(opts: OpenRouterOptions = {}) {
    this.env = opts.env ?? process.env;
    const key = opts.apiKey ?? this.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set");
    this.apiKey = key;
    this.maxTokens = opts.maxTokens ?? 1200;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retryDelaysMs = opts.retryDelaysMs ?? [30_000, 120_000, 480_000];
    this.fetch = opts.fetch ?? fetch;
  }

  model(task: LlmTask): string {
    const m = this.env[MODEL_ENV[task]] || DEFAULT_MODEL[task];
    if (!m) throw new Error(`${MODEL_ENV[task]} is not set`);
    return m;
  }

  async worstCaseUsd(task: LlmTask, input: LlmRequest<unknown>): Promise<number> {
    const p = await this.priceOf(this.model(task));
    // ~3 characters per token is a safe overestimate for English prompts and JSON schemas.
    const promptTokens = Math.ceil((input.system.length + input.user.length + JSON.stringify(input.jsonSchema).length) / 3);
    const search = input.webSearch ? SEARCH_FEE_USD + input.webSearch.maxResults * SEARCH_TOKENS_PER_RESULT * p.prompt : 0;
    return promptTokens * p.prompt + ((input.maxTokens ?? this.maxTokens) + (input.reasoningTokens ?? 0)) * p.completion + search;
  }

  async json<T>(task: LlmTask, input: LlmRequest<T>): Promise<LlmCallResult<T>> {
    const model = this.model(task);
    let cost = 0;
    let lastError: unknown;
    // Invalid output → one retry, then fail (§5.1 step 4).
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.complete(model, input);
      cost += res.cost;
      try {
        const data = input.parse(JSON.parse(res.content));
        return { data, model: res.model, costUsd: cost, ...(input.webSearch ? { citations: res.citations } : {}) };
      } catch (e) {
        lastError = e;
      }
    }
    throw Object.assign(new ProviderError(`invalid ${input.schemaName} output: ${String(lastError)}`, false), { costUsd: cost });
  }

  private async complete(model: string, input: LlmRequest<unknown>) {
    const body = JSON.stringify({
      model,
      max_tokens: (input.maxTokens ?? this.maxTokens) + (input.reasoningTokens ?? 0),
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      response_format: { type: "json_schema", json_schema: { name: input.schemaName, strict: true, schema: input.jsonSchema } },
      provider: { require_parameters: true },
      // No hidden reasoning by default: it is billed as output and, when long, cut the JSON short
      // (2026-11-08: 385 of 480 tokens spent reasoning, "Unterminated string"). A request that
      // needs it (drafts) gets its own budget on top of its output (LlmRequest.reasoningTokens).
      reasoning: input.reasoningTokens ? { max_tokens: input.reasoningTokens } : { enabled: false },
      usage: { include: true },
      ...(input.webSearch ? { plugins: [{ id: "web", engine: "parallel", mode: "fast", max_results: input.webSearch.maxResults }] } : {}),
    });
    const json = await this.request("/chat/completions", { method: "POST", body });
    const message = json?.choices?.[0]?.message;
    const content = message?.content;
    if (typeof content !== "string") throw new ProviderError("no content in completion", true);
    const cost = Number(json.usage?.cost);
    const citations: string[] = (Array.isArray(message.annotations) ? message.annotations : [])
      .map((a: { url_citation?: { url?: unknown } }) => a?.url_citation?.url)
      .filter((u: unknown): u is string => typeof u === "string");
    return { content, citations, model: String(json.model ?? model), cost: Number.isFinite(cost) ? cost : 0 };
  }

  private async request(path: string, init: { method: string; body?: string }): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetch(BASE + path, {
          ...init,
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) return await res.json();
        const text = (await res.text()).slice(0, 300);
        throw new ProviderError(`OpenRouter ${res.status}: ${text}`, res.status === 429 || res.status >= 500);
      } catch (e) {
        // Timeouts and network failures are retryable; other 4xx fail at once (§5.3a).
        const retryable = e instanceof ProviderError ? e.retryable : true;
        const delay = this.retryDelaysMs[attempt];
        if (!retryable || delay === undefined) throw e;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private priceOf(model: string): Promise<Pricing> {
    this.pricing ??= this.request("/models", { method: "GET" }).then(
      (j: { data: { id: string; pricing: { prompt: string; completion: string } }[] }) =>
        new Map(j.data.map((m) => [m.id, { prompt: Number(m.pricing.prompt), completion: Number(m.pricing.completion) }])),
      (e) => {
        this.pricing = null; // don't cache a failed price lookup
        throw e;
      },
    );
    return this.pricing.then((m) => {
      const p = m.get(model);
      if (!p) throw new Error(`no OpenRouter price for ${model}`);
      return p.prompt < 0 || p.completion < 0 ? ROUTER_CEILING : p;
    });
  }
}
