// Provider interfaces (Q66). Business logic depends on these, never on a provider SDK.
// Each has a real implementation in the worker and a fake in tests.

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

export interface JobSource {
  readonly name: string;
  // Starts a run; results arrive later via webhook → fetchItems.
  startRun(input: { country: RawJobPost["country"]; title: string; limit: number }): Promise<{ runId: string }>;
  fetchItems(datasetId: string, offset: number, limit: number): Promise<RawJobPost[]>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  readonly costPerQuery: number;
  search(queries: { id: string; q: string; country: string }[]): Promise<Map<string, SearchResult[]>>;
}

export interface LlmCallResult<T> {
  data: T;
  model: string;
  costUsd: number;
}

export type LlmTask = "extraction" | "drafts" | "roast" | "resolve";

export interface LlmRequest<T> {
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: object;
  parse: (raw: unknown) => T;
}

export interface LlmClient {
  // `task` maps to a model env setting (MODEL_EXTRACTION, MODEL_DRAFTS, MODEL_ROAST).
  json<T>(task: LlmTask, input: LlmRequest<T>): Promise<LlmCallResult<T>>;
  // Most the call can cost (full prompt + max output) — what the budget gate reserves (§5.3).
  worstCaseUsd(task: LlmTask, input: LlmRequest<unknown>): Promise<number>;
}

export interface DomainRegistry {
  registeredAt(domain: string): Promise<Date | null>;
}

export interface WebFetcher {
  // SSRF-safe fetch (§8.2 guards). Returns null when unreachable / blocked.
  get(url: string): Promise<{ finalUrl: string; status: number; html: string } | null>;
}
