// Registers the Apify webhook for the Indeed actor (run once per deploy; safe to repeat).
// Usage: PUBLIC_BASE_URL=https://<app> npm run apify:webhook
import { ApifyClient, INDEED_ACTOR } from "@bs/integrations";

const base = process.env.PUBLIC_BASE_URL;
const secret = process.env.APIFY_WEBHOOK_SECRET;
if (!base || !secret) throw new Error("PUBLIC_BASE_URL and APIFY_WEBHOOK_SECRET must be set");
const url = new URL("/api/webhooks/apify", base).href;
const hook = await new ApifyClient().ensureWebhook({ actor: INDEED_ACTOR, url, secret, idempotencyKey: `bs-indeed-${new URL(base).host}` });
console.log(`webhook ${hook.id} → ${url}`);
