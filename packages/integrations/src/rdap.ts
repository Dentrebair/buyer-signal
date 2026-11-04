// Domain registration date via RDAP (PRD §6.7 step 2, Q57). Free, no key. Asks each registry's
// own RDAP server from the IANA bootstrap file, not the rdap.org relay (which returned 403 for
// some .org domains in Sprint 0). Verified 2026-11-04 on the 49 Sprint 0 websites: 42 dated;
// .ae and .co have no RDAP server in the bootstrap, so their age stays unknown.
import type { DomainAge } from "@bs/core";
import { ProviderError } from "./openrouter.ts";

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 24 * 3600 * 1000; // IANA asks clients to cache the file
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/; // goes into a URL path
const MAX_BYTES = 1024 * 1024;

interface Bootstrap {
  services: [string[], string[]][];
}

export class RdapClient implements DomainAge {
  private servers?: { at: number; byTld: Map<string, string> };

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  // Registration date, or null when the registry has no RDAP server, no record, or no date.
  // Throws ProviderError when the registry could not be asked (network, 5xx, rate limit).
  async registeredAt(domain: string): Promise<Date | null> {
    const d = domain.toLowerCase();
    if (!DOMAIN.test(d)) return null;
    const base = await this.serverFor(d);
    if (!base) return null;
    const res = await this.get(`${base}${base.endsWith("/") ? "" : "/"}domain/${d}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new ProviderError(`rdap ${res.status} for ${d}`, res.status === 429 || res.status >= 500);
    const body = (await readJson(res)) as { events?: { eventAction?: string; eventDate?: string }[] };
    const reg = body.events?.find((e) => e.eventAction === "registration")?.eventDate;
    const date = reg ? new Date(reg) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  // Longest matching suffix wins, so "co.in" would beat "in" if a registry listed it.
  private async serverFor(domain: string): Promise<string | null> {
    if (!this.servers || Date.now() - this.servers.at > BOOTSTRAP_TTL_MS) {
      const res = await this.get(BOOTSTRAP_URL);
      if (!res.ok) throw new ProviderError(`rdap bootstrap ${res.status}`, true);
      const b = (await readJson(res)) as Bootstrap;
      const byTld = new Map<string, string>();
      for (const [tlds, urls] of b.services ?? []) {
        const https = urls.find((u) => u.startsWith("https://"));
        if (https) for (const t of tlds) byTld.set(t.toLowerCase(), https);
      }
      this.servers = { at: Date.now(), byTld };
    }
    const labels = domain.split(".");
    for (let i = 1; i < labels.length; i++) {
      const hit = this.servers.byTld.get(labels.slice(i).join("."));
      if (hit) return hit;
    }
    return null;
  }

  private async get(url: string): Promise<Response> {
    try {
      return await this.fetchFn(url, { headers: { Accept: "application/rdap+json, application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new ProviderError(`rdap fetch failed: ${(e as Error).message}`, true);
    }
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new ProviderError("rdap response too large", false);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("rdap response is not JSON", false);
  }
}
