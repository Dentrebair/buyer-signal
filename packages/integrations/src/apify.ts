// Apify REST client (v2). Token always in the Authorization header, never the URL (logs).
// The webhook secret is never in a URL either: per-run ("ad-hoc") webhooks travel base64 in the
// start-run query string, so we register one persistent webhook per actor instead (ensureWebhook).
// Shapes verified against the live API on 2026-11-03: POST /acts/{id}/runs query params,
// run.chargedEventCounts, /users/me/limits.monthlyUsageCycle.
import { ProviderError } from "./openrouter.ts";

const BASE = "https://api.apify.com/v2";

export type RunStatus = "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTING" | "ABORTED" | "TIMING-OUT" | "TIMED-OUT";
export const TERMINAL: RunStatus[] = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"];

export interface ApifyRun {
  id: string;
  status: RunStatus;
  defaultDatasetId: string;
  chargedEventCounts: Record<string, number> | null;
  startedAt: string;
}

export interface StartOptions {
  maxItems: number;
  maxTotalChargeUsd: number;
  timeoutSecs?: number;
}

export interface ApifyOptions {
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ApifyClient {
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;

  constructor(opts: ApifyOptions = {}) {
    const token = opts.token ?? process.env.APIFY_TOKEN;
    if (!token) throw new Error("APIFY_TOKEN is not set");
    this.token = token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetch = opts.fetch ?? fetch;
  }

  async startRun(actor: string, input: object, o: StartOptions): Promise<ApifyRun> {
    const q = new URLSearchParams({
      maxItems: String(o.maxItems),
      maxTotalChargeUsd: o.maxTotalChargeUsd.toFixed(4),
      timeout: String(o.timeoutSecs ?? 300),
    });
    return (await this.call(`/acts/${actor.replace("/", "~")}/runs?${q}`, { method: "POST", body: JSON.stringify(input) })).data;
  }

  // One webhook for every run of the actor; secret in the JSON body. Same idempotencyKey →
  // Apify returns the existing webhook, so this is safe to run on every deploy.
  async ensureWebhook(x: { actor: string; url: string; secret: string; idempotencyKey: string }): Promise<{ id: string }> {
    const actorId = (await this.call(`/acts/${x.actor.replace("/", "~")}`)).data.id as string;
    const body = {
      eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.ABORTED", "ACTOR.RUN.TIMED_OUT"],
      condition: { actorId },
      requestUrl: x.url,
      headersTemplate: JSON.stringify({ "X-Apify-Webhook-Secret": x.secret }),
      idempotencyKey: x.idempotencyKey,
      description: "buying-signal worker: run finished",
    };
    return (await this.call("/webhooks", { method: "POST", body: JSON.stringify(body) })).data;
  }

  async getRun(runId: string): Promise<ApifyRun> {
    return (await this.call(`/actor-runs/${runId}`)).data;
  }

  async datasetItems<T = unknown>(datasetId: string, offset: number, limit: number): Promise<T[]> {
    return this.call(`/datasets/${datasetId}/items?clean=true&offset=${offset}&limit=${limit}`);
  }

  // Final item count of a finished run's dataset (its charge counts can lag behind, see onApifyRunEvent).
  async datasetItemCount(datasetId: string): Promise<number> {
    return Number((await this.call(`/datasets/${datasetId}`)).data.itemCount ?? 0);
  }

  // Billing cycle and real usage — the daily reconcile overwrites the gate counter with it (§5.3).
  async usage(): Promise<{ cycleStart: Date; cycleEnd: Date; usageUsd: number; limitUsd: number }> {
    const d = (await this.call("/users/me/limits")).data;
    return {
      cycleStart: new Date(d.monthlyUsageCycle.startAt),
      cycleEnd: new Date(d.monthlyUsageCycle.endAt),
      usageUsd: Number(d.current.monthlyUsageUsd),
      limitUsd: Number(d.limits.maxMonthlyUsageUsd),
    };
  }

  private async call(path: string, init: { method?: string; body?: string } = {}): Promise<any> {
    let res: Response;
    try {
      res = await this.fetch(BASE + path, {
        method: init.method ?? "GET",
        body: init.body,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ProviderError(`Apify ${path.split("?")[0]}: ${(e as Error).message}`, true);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new ProviderError(`Apify ${res.status} ${path.split("?")[0]}: ${text}`, res.status === 429 || res.status >= 500);
    }
    return res.json();
  }
}

// Exact cost of a finished pay-per-event run from its charged events.
export function runCostUsd(run: Pick<ApifyRun, "chargedEventCounts">, prices: Record<string, number>): number {
  return Object.entries(run.chargedEventCounts ?? {}).reduce((sum, [event, n]) => sum + n * (prices[event] ?? 0), 0);
}
