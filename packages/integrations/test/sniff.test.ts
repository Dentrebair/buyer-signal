import { describe, expect, it } from "vitest";
import { type FetchOptions, type Page, sniffWebsite } from "../src/index.ts";

const NOW = new Date("2026-11-04T00:00:00Z");
const html = (body: string, head = "") => `<html><head>${head}</head><body>${body}</body></html>`;

function fakeFetch(site: Record<string, string | { url: string; html: string }>) {
  const calls: string[] = [];
  const fetch = async (url: string, opts?: FetchOptions): Promise<Page | null> => {
    calls.push(url);
    const hit = site[url];
    if (hit === undefined) return null;
    const p = typeof hit === "string" ? { url, html: hit } : hit;
    return { url: p.url, status: 200, html: p.html, headers: opts?.kind === "text" ? { "content-type": "text/plain" } : { "x-powered-by": "PHP/8.2" } };
  };
  return { fetch, calls };
}

describe("website sniff (§5.4)", () => {
  it("fetches the homepage, linked pages, robots.txt and llms.txt, then audits with real fingerprints", async () => {
    const { fetch, calls } = fakeFetch({
      "https://acme.example/": html('<a href="/contact-us">Contact</a><a href="https://wa.me/971500000000">WhatsApp</a>', '<meta name="generator" content="WordPress 6.4">'),
      "https://acme.example/contact-us": html('<a href="mailto:info@acme.example">info@acme.example</a>'),
      "https://acme.example/robots.txt": "User-agent: GPTBot\nDisallow: /",
      "https://acme.example/llms.txt": "<html>not found page</html>", // a host that answers every path
    });
    const r = await sniffWebsite({ domain: "acme.example", company: "Acme Freight", vertical: "legal", country: "ae", now: NOW }, fetch);
    expect(r.reachable).toBe(true);
    if (!r.reachable) return;
    expect(r.pages).toEqual(["https://acme.example/", "https://acme.example/contact-us"]);
    expect(r.tech.map((t) => t.name)).toEqual(expect.arrayContaining(["WordPress", "PHP"]));
    expect(r.audit.gate3).toMatchObject({ aiBotsBlocked: ["GPTBot"], noLlmsTxt: true });
    expect(r.audit.gate4).toBe("raw_wa_link");
    expect(r.audit.contacts).toMatchObject({ emails: ["info@acme.example"], whatsapp: ["+971500000000"] });
    expect(calls).toContain("https://acme.example/robots.txt");
  });

  it("a homepage that redirects to another domain is not the company's site", async () => {
    const { fetch } = fakeFetch({ "https://acme.example/": { url: "https://spam-casino.example/", html: html("Win big") } });
    expect(await sniffWebsite({ domain: "acme.example", company: "Acme Freight", vertical: null, country: "us", now: NOW }, fetch)).toEqual({
      reachable: false,
      reason: "redirects to another site (spam-casino.example)",
    });
  });

  it("a redirect to another domain that names the company is still its site", async () => {
    const { fetch } = fakeFetch({
      "https://acme.example/": { url: "https://www.acmefreight.example/", html: html('<h1>Acme Freight LLC</h1><a href="/contact">Contact</a>') },
      "https://www.acmefreight.example/contact": html("Call us"),
    });
    const r = await sniffWebsite({ domain: "acme.example", company: "Acme Freight", vertical: null, country: "us", now: NOW }, fetch);
    expect(r).toMatchObject({ reachable: true, finalUrl: "https://www.acmefreight.example/", pages: ["https://www.acmefreight.example/", "https://www.acmefreight.example/contact"] });
  });

  it("falls back to http once, and reports an unreachable site", async () => {
    const http = fakeFetch({ "http://acme.example/": html("Plain old site") });
    expect((await sniffWebsite({ domain: "acme.example", company: "Acme Freight", vertical: null, country: "us", now: NOW }, http.fetch)).reachable).toBe(true);
    const none = fakeFetch({});
    expect(await sniffWebsite({ domain: "acme.example", company: "Acme Freight", vertical: null, country: "us", now: NOW }, none.fetch)).toMatchObject({ reachable: false });
    expect(none.calls).toEqual(["https://acme.example/", "http://acme.example/"]);
  });

  it("processes 1 MB of HTML without error (Sprint 2 acceptance)", async () => {
    const block = '<div class="row"><p>Freight forwarding and customs clearance for SMEs.</p><table><tr><td><a href="/services">Services</a></td></tr></table></div>';
    const big = html(block.repeat(Math.ceil(1_048_576 / block.length)), '<script src="/wp-includes/js/jquery/jquery.min.js?ver=3.7.1"></script>');
    expect(big.length).toBeGreaterThan(1_048_576);
    const { fetch } = fakeFetch({ "https://acme.example/": big });
    const t = Date.now();
    const r = await sniffWebsite({ domain: "acme.example", company: "Acme Freight", vertical: "logistics", country: "in", now: NOW }, fetch);
    expect(r.reachable).toBe(true);
    expect(Date.now() - t).toBeLessThan(20_000);
  }, 30_000);
});
