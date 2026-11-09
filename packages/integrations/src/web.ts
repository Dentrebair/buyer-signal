// Plain-HTTP page fetch for company websites (resolve homepage check now, sniff-domain later).
// Hostnames come from search results, so every connection is checked at connect time: private,
// loopback, link-local and metadata addresses are refused, including after a redirect or a DNS
// change between lookup and connect.
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

// §8.2 guards: 2 MB, 8 s total, 3 redirects.
const MAX_BYTES = 2 * 1024 * 1024;
const TOTAL_MS = 8_000;
const MAX_REDIRECTS = 3;
const UA = "Mozilla/5.0 (compatible; buying-signal/0.1; company website check)";

export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPublicAddress(v6.slice(7));
  // 64:ff9b:: (NAT64) and 2002:: (6to4) carry an IPv4 address inside, which could be a private one,
  // and 2001:db8:: is for documentation: none is needed to reach a company website, so all refused.
  if (v6.startsWith("64:ff9b:") || v6.startsWith("2002:") || v6.startsWith("2001:db8:")) return false;
  return !(v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb"));
}

// Refuses non-public addresses at connect time, so a redirect or DNS change can't route around it.
const guardedLookup: typeof dnsLookup = ((host: string, opts: object, cb: (e: Error | null, addr: unknown, family?: number) => void) => {
  dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = addrs as { address: string; family: number }[];
    const ok = list.filter((a) => isPublicAddress(a.address));
    if (!ok.length || ok.length !== list.length) return cb(Object.assign(new Error(`refused non-public address for ${host}`), { code: "EREFUSED" }), "");
    (opts as { all?: boolean }).all ? cb(null, ok) : cb(null, ok[0]!.address, ok[0]!.family);
  });
}) as typeof dnsLookup;

export interface Page {
  url: string; // after redirects
  status: number;
  html: string; // the body (plain text when fetched with kind "text")
  headers: Record<string, string>; // lower-case names; repeated headers joined with "\n"
}

export interface FetchOptions {
  kind?: "html" | "text"; // "text": robots.txt, llms.txt
  timeoutMs?: number; // whole fetch, redirects included
}

// GET a page, following up to 3 redirects. null when unreachable, blocked, not 200, or the
// wrong content type. Never throws.
export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<Page | null> {
  const kind = opts.kind ?? "html";
  const deadline = Date.now() + (opts.timeoutMs ?? TOTAL_MS);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // IP literals skip the DNS lookup, so check them here.
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !isPublicAddress(host)) return null;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const res = await get(u, left, kind).catch(() => null);
    if (!res) return null;
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, u).toString();
      continue;
    }
    return res.status === 200 && res.body ? { url: current, status: res.status, html: res.body, headers: res.headers } : null;
  }
  return null;
}

const TYPES = { html: /text\/html|application\/xhtml/i, text: /text\/plain/i };

function get(u: URL, timeoutMs: number, kind: "html" | "text"): Promise<{ status: number; location?: string; body: string; headers: Record<string, string> }> {
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(
      u,
      { lookup: guardedLookup, timeout: timeoutMs, headers: { "User-Agent": UA, Accept: kind === "html" ? "text/html" : "text/plain", "Accept-Encoding": "identity" } },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers["content-type"] ?? "");
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join("\n") : String(v);
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, body: "", headers });
        }
        if (!TYPES[kind].test(type)) {
          res.resume();
          return resolve({ status, body: "", headers });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) return res.destroy(); // keep what we have: the head and the top of the page
          chunks.push(c);
        });
        res.on("close", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8"), headers }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    // `timeout` above is per idle socket; this caps the whole response (§8.2: 8 s total).
    const timer = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
  });
}

// Visible text, roughly: enough to look for a company name. (sniff-domain gets Cheerio.)
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 200_000);
}
