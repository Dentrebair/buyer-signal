// pg-boss queue names and job payloads (PRD §5.2) — the contract between web and worker.
import { z } from "zod";
import { AuthorRelation, StructuredIntelligence } from "./contracts.ts";
import { SOCIAL_KEYWORD } from "./social.ts";
import { VerticalSlug } from "./verticals.ts";

export const Q = {
  startBoardRun: "start-board-run",
  apifyRunEvent: "apify-run-event",
  fetchDataset: "fetch-dataset",
  extractLlm: "extract-llm",
  resolveBatch: "resolve-batch",
  sniffSeeds: "sniff-seeds",
  sniffDomain: "sniff-domain",
  ingestRotation: "ingest-rotation",
  startSocialRun: "start-social-run",
  fetchSocial: "fetch-social",
  extractSocial: "extract-social",
  pollRuns: "poll-runs",
  reconcileApify: "reconcile-apify",
  deadLetter: "dead-letter",
} as const;
export type QueueName = (typeof Q)[keyof typeof Q];

export const CountryCode = z.enum(["in", "ae", "us"]);

export const StartBoardRun = z.object({
  country: CountryCode,
  title: z.string().min(2).max(80),
  location: z.string().max(80).optional(),
  vertical: VerticalSlug.nullable(),
  limit: z.number().int().min(1).max(100),
});
export type StartBoardRun = z.infer<typeof StartBoardRun>;

// Sent by the webhook route and by the poll job; the worker reads the run itself.
const ApifyId = z.string().regex(/^[A-Za-z0-9]{5,40}$/); // used in Apify API paths
// recheck: how many more times to look again (20 s apart) while the run is still going, so
// results show in under a minute instead of at the next 5-minute poll.
export const ApifyRunEvent = z.object({ apifyRunId: ApifyId, recheck: z.number().int().min(0).max(60).default(0) });
export const RECHECK_SECONDS = 20;
export const RECHECKS = 30; // ~10 min; poll-runs covers anything longer
export type ApifyRunEvent = z.input<typeof ApifyRunEvent>; // recheck may be left out (webhook, tests)

export const FetchDataset = z.object({
  runId: z.uuid(),
  datasetId: ApifyId,
  offset: z.number().int().min(0),
});
export type FetchDataset = z.infer<typeof FetchDataset>;

export const JobPostPayload = z.object({
  naturalId: z.string(),
  url: z.string(),
  title: z.string(),
  company: z.string().nullable(),
  description: z.string(),
  postedAt: z.iso.datetime().nullable(),
  city: z.string().nullable(),
  country: CountryCode,
  boardWebsite: z.string().nullable(),
  boardEmployeeBand: z.string().nullable(),
});

export const ExtractLlm = z.object({
  runId: z.uuid(),
  vertical: VerticalSlug.nullable(),
  post: JobPostPayload,
  founderDependency: z.boolean(), // §6.6 deterministic override from the gate
  // A LinkedIn post (§4.1a) takes the same path to a card once extracted; defaults keep jobs
  // queued before this field existed valid.
  source: z.enum(["job_post", "linkedin_post"]).default("job_post"),
  author: AuthorRelation.nullable().default(null),
});
export type ExtractLlm = z.infer<typeof ExtractLlm>;
export type ExtractLlmInput = z.input<typeof ExtractLlm>;

export const StartSocialRun = z.object({
  vertical: VerticalSlug,
  keyword: z.string().regex(SOCIAL_KEYWORD).nullable().default(null), // else the vertical's next topics
  country: CountryCode, // Google results country (gl)
  pages: z.number().int().min(1).max(3), // ~10 results each
});
export type StartSocialRun = z.infer<typeof StartSocialRun>;

export const FetchSocial = z.object({ runId: z.uuid(), datasetId: z.string().regex(/^[A-Za-z0-9]{5,40}$/) });
export type FetchSocial = z.infer<typeof FetchSocial>;

export const ExtractSocial = z.object({
  runId: z.uuid(),
  country: CountryCode,
  vertical: VerticalSlug.nullable().default(null), // the run's vertical: the gate's atoms, and the card's when the AI gives none
  naturalId: z.string(),
  url: z.string(),
  text: z.string().max(2000), // title + snippet from the search result, never the page (for the LLM)
  snippet: z.string().max(2000), // snippet only: the evidence shown on the card (titles carry author names)
  postedAt: z.iso.datetime(),
  founderDependency: z.boolean(),
});
export type ExtractSocial = z.infer<typeof ExtractSocial>;

// Stored in resolve_queue.payload: everything needed to make the card once a website is found.
export const ResolvePayload = z.object({ job: ExtractLlm, si: StructuredIntelligence, model: z.string() });
export type ResolvePayload = z.infer<typeof ResolvePayload>;

// One website sniff per seed (§5.4). The worker reads the domain and company from seed_urls.
export const SniffDomain = z.object({ seedId: z.uuid() });
export type SniffDomain = z.infer<typeof SniffDomain>;
