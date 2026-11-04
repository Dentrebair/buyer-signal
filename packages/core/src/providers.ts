// Provider interfaces (Q66). Business logic depends on these, never on a provider SDK.
// Each has a real implementation in @bs/integrations and a fake in tests. Add an interface when
// its first implementation lands (search, RDAP and website fetch arrive in Sprint 2).

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
