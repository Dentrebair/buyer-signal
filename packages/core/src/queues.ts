// pg-boss queue names and job payloads (PRD §5.2) — the contract between web and worker.
import { z } from "zod";
import { VerticalSlug } from "./verticals.ts";

export const Q = {
  startBoardRun: "start-board-run",
  apifyRunEvent: "apify-run-event",
  fetchDataset: "fetch-dataset",
  extractLlm: "extract-llm",
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
export const ApifyRunEvent = z.object({ apifyRunId: z.string().min(5).max(40) });
export type ApifyRunEvent = z.infer<typeof ApifyRunEvent>;

export const FetchDataset = z.object({
  runId: z.uuid(),
  datasetId: z.string().min(5).max(40),
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
});
export type ExtractLlm = z.infer<typeof ExtractLlm>;

export const DeadLetter = z.object({ queue: z.string(), data: z.unknown(), error: z.string() });
