// One website sniff (PRD §5.4 steps 1–4): homepage + up to 3 linked pages (contact, services,
// careers), robots.txt and /llms.txt, all through the guarded fetch; then the tech-stack
// matcher and the 4-Gate audit. Plain HTTP only, so it costs nothing.
import { readFileSync } from "node:fs";
import {
  type Country,
  type Fingerprints,
  type SiteAudit,
  type SitePage,
  type Tech,
  type VerticalSlug,
  auditSite,
  detectTech,
  pageMatch,
  parseHtml,
  pickLinks,
  visibleText,
} from "@bs/core";
import { type FetchOptions, type Page, fetchPage } from "./web.ts";

let fingerprints: Fingerprints | undefined;
export function loadFingerprints(): Fingerprints {
  fingerprints ??= JSON.parse(readFileSync(new URL("../data/webappanalyzer.json", import.meta.url), "utf8")) as Fingerprints;
  return fingerprints;
}

export type SniffResult =
  | { reachable: false; reason: string }
  | { reachable: true; finalUrl: string; pages: string[]; tech: Tech[]; audit: SiteAudit };

export interface SniffInput {
  domain: string;
  company: string | null; // to accept a redirect to the company's other domain
  vertical: VerticalSlug | null;
  country: Country | null;
  now: Date;
}

type Fetch = (url: string, opts?: FetchOptions) => Promise<Page | null>;

export async function sniffWebsite(x: SniffInput, fetch: Fetch = fetchPage, fp: Fingerprints = loadFingerprints()): Promise<SniffResult> {
  // https first, then http; one retry at most (§5.4: no unblocking, no retries beyond one).
  const home = (await fetch(`https://${x.domain}/`)) ?? (await fetch(`http://${x.domain}/`));
  if (!home) return { reachable: false, reason: "no HTML response (blocked, timeout, or not a website)" };
  // A homepage that redirects to another domain (sold, hijacked, parked) isn't this company's site.
  const $home = parseHtml(home.html);
  const pages: SitePage[] = [{ url: home.url, $: $home, text: visibleText($home) }];
  // A redirect to another domain is the same business only if that page names it (e.g.
  // batonrougewater.com → brwater.com); otherwise it was sold, parked or hijacked.
  const sameSite = (url: string, domain: string) => {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const own = domain.replace(/^www\./, "");
    return host === own || host.endsWith(`.${own}`);
  };
  if (!sameSite(home.url, x.domain) && !(x.company && pageMatch(pages[0]!.text, x.company, null)))
    return { reachable: false, reason: `redirects to another site (${new URL(home.url).hostname})` };
  const onSite = (url: string) => sameSite(url, new URL(home.url).hostname);
  const tech = detectTech(fp, { $: $home, url: home.url, headers: home.headers, text: pages[0]!.text });

  const origin = new URL(home.url).origin;
  const [linked, robots, llms] = await Promise.all([
    Promise.all(pickLinks($home, home.url).map((u) => fetch(u))),
    fetch(`${origin}/robots.txt`, { kind: "text" }),
    fetch(`${origin}/llms.txt`, { kind: "text" }),
  ]);
  for (const p of linked) {
    if (!p || !onSite(p.url)) continue;
    const $ = parseHtml(p.html);
    pages.push({ url: p.url, $, text: visibleText($) });
  }

  const audit = auditSite({
    pages,
    tech,
    robotsTxt: robots?.html ?? null,
    // Some hosts answer every path with 200: only count a file that looks like llms.txt.
    hasLlmsTxt: !!llms && /^#\s+\S/m.test(llms.html),
    vertical: x.vertical,
    country: x.country,
    now: x.now,
  });
  return { reachable: true, finalUrl: home.url, pages: pages.map((p) => p.url), tech, audit };
}
