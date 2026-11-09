// Provider interfaces (Q66). Business logic depends on these, never on a provider SDK.
// Each has a real implementation in @bs/integrations and a fake in tests. Add an interface when
// its first implementation lands.

export interface RawJobPost {
  naturalId: string; // 'job:<board>:<id>'
  url: string;
  title: string;
  company: string | null;
  description: string;
  postedAt: Date | null;
  city: string | null;
  country: "in" | "ae" | "us";
  boardWebsite: string | null;
  boardEmployeeBand: string | null;
}

export interface LlmCallResult<T> {
  data: T;
  model: string;
  costUsd: number;
  citations?: string[]; // URLs the provider's web search returned (only with `webSearch`)
}

export type LlmTask = "extraction" | "drafts" | "roast" | "resolve" | "match";

export interface LlmRequest<T> {
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: object;
  parse: (raw: unknown) => T;
  webSearch?: { maxResults: number }; // let the model search the web first (resolve, §5.1 step 5)
  maxTokens?: number; // output budget, when the client default (1,200) is too small or too large
  // Hidden reasoning budget, added on top of maxTokens so it can never cut the answer short. Off
  // when absent; some models refuse to run without it (Claude Sonnet 5.5, 2026-11-08).
  reasoningTokens?: number;
  // When the task's model is OpenRouter's Auto Router: the only models it may pick (exact ids).
  routerModels?: readonly string[];
}

export interface LlmClient {
  // `task` maps to a model env setting (MODEL_EXTRACTION, MODEL_DRAFTS, MODEL_ROAST).
  json<T>(task: LlmTask, input: LlmRequest<T>): Promise<LlmCallResult<T>>;
  // Most the call can cost (full prompt + max output) — what the budget gate reserves (§5.3).
  worstCaseUsd(task: LlmTask, input: LlmRequest<unknown>): Promise<number>;
}

// Domain registration date (§6.7 step 2). null = unknown; throws when the registry can't be asked.
export interface DomainAge {
  registeredAt(domain: string): Promise<Date | null>;
}

// Text embeddings (trends, §5.6): one vector per text, all the same length (EMBED_DIMS).
export const EMBED_DIMS = 768;
export interface Embedder {
  embed(texts: string[]): Promise<{ vectors: number[][]; model: string; costUsd: number }>;
}

