// Dependencies every job takes (so tests run them with fakes), shared constants and helpers.
import type pg from "pg";
import {
  type DomainAge,
  type LlmClient,
  type QueueName,
  type RawArchive,
  type Mailer,
  type Embedder,
} from "@bs/core";
import {
  type DropCounter,
  bumpCounters,
} from "@bs/db";
import {
  type ApifyClient,
  type Page,
  type SniffInput,
  type SniffResult,
  INDEED_PRICES,
} from "@bs/integrations";

export interface Settings {
  apifyCycleCapUsd: number;
  rotationEnabled: boolean; // ROTATION_ENABLED: the daily ingest-rotation starts paid runs only when true
  boardSlotsPerDay: number; // BOARD_SLOTS_PER_DAY (§4.1)
  boardPostsPerSlot: number; // BOARD_POSTS_PER_SLOT
  socialSlotsPerDay: number; // SOCIAL_SLOTS_PER_DAY (§4.1c): LinkedIn post searches a day
  liPostsPerTopic: number; // LI_POSTS_PER_TOPIC (§4.1d)
  liCommentsPerPost: number; // LI_COMMENTS_PER_POST
  searchDailyCap: number; // SEARCH_DAILY_CAP: paid website searches per UTC day (§5.1 step 5c)
  healthUrl: string; // HEALTH_URL: the link in the alert email
}

// `tx`: enqueue inside that transaction, so the job exists only if the transaction commits.
export type Send = (
  queue: QueueName,
  data: object,
  opts?: { startAfter?: number; singletonKey?: string },
  tx?: pg.PoolClient,
) => Promise<unknown>;

export interface Deps {
  pool: pg.Pool;
  apify: Pick<ApifyClient, "startRun" | "getRun" | "datasetItems" | "datasetItemCount" | "usage">;
  llm: LlmClient;
  fetchPage: (url: string) => Promise<Page | null>;
  rdap: DomainAge;
  sniff: (x: SniffInput) => Promise<SniffResult>;
  archive: RawArchive;
  mailer: Mailer | null; // null until RESEND_API_KEY and ALERT_EMAIL_TO are set: alerts stay on /health
  embedder: Embedder; // trends (§5.6), inside the monthly AI cap
  send: Send;
  settings: Settings;
  now: () => Date;
  log: (msg: string, extra?: object) => void;
}

export const PAGE = 25; // §5.3a: ≤ 25 dataset items per job
export const PLAN = { pricePerItem: INDEED_PRICES["apify-default-dataset-item"], startPrice: INDEED_PRICES["apify-actor-start"] };
export const DEFER_SECONDS = 3600; // over cap → try again in an hour (§5.3)

export async function drop(d: Deps, runId: string, counter: DropCounter): Promise<string> {
  await bumpCounters(d.pool, runId, { [counter]: 1 });
  return counter;
}
