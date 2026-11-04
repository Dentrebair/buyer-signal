import { describe, expect, it } from "vitest";
import { type Fingerprints, type SitePage, type Tech, auditSite, blockedBots, detectTech, isClientRendered, parseHtml, pickLinks, visibleText } from "../src/index.ts";

const NOW = new Date("2026-11-04T00:00:00Z");
const page = (html: string, url = "https://acme.example/"): SitePage => {
  const $ = parseHtml(html);
  return { url, $, text: visibleText($) };
};
const audit = (pages: SitePage[], over: Partial<Parameters<typeof auditSite>[0]> = {}) =>
  auditSite({ pages, tech: [], robotsTxt: null, hasLlmsTxt: false, vertical: "healthcare", country: "ae", now: NOW, ...over });
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join(" ");

describe("tech-stack matcher (§5.4 step 3)", () => {
  const fp: Fingerprints = {
    categories: { "1": "CMS", "59": "JavaScript libraries", "52": "Live chat", "12": "JavaScript frameworks" },
    technologies: {
      WordPress: { cats: [1], meta: { generator: "^WordPress ?([\\d.]+)?\\;version:\\1" }, implies: ["PHP"] },
      PHP: { cats: [27], headers: { "X-Powered-By": "^php/?([\\d.]+)?\\;version:\\1" } },
      jQuery: { cats: [59], scriptSrc: ["jquery(?:-(\\d+\\.\\d+\\.\\d+))?[/.-]\\;version:\\1"] },
      Tawk: { cats: [52], scriptSrc: "embed\\.tawk\\.to" },
      Preact: { cats: [12], dom: { "body": { properties: { __k: "" } } } },
      Cart: { cats: [6], dom: ["a[href*='/cart']"] },
      Plugin: { cats: [87], html: "wp-plugin-x", requires: "Joomla" },
      Analytics: { cats: [10], cookies: { "_ga_*": "" } },
      Broken: { cats: [19], html: "([unclosed" },
    },
  };
  const run = (html: string, headers: Record<string, string> = {}) => {
    const $ = parseHtml(html);
    return detectTech(fp, { $, url: "https://acme.example/", headers, text: visibleText($) });
  };

  it("matches meta, script src and cookies, with versions, and follows implies", () => {
    const t = run(
      '<meta name="generator" content="WordPress 6.4.2"><script src="/js/jquery-1.12.4.min.js"></script><script src="https://embed.tawk.to/x"></script>',
      { "set-cookie": "_ga_ABC=1; Path=/\nother=2" },
    );
    expect(t.map((x) => [x.name, x.version])).toEqual([["Analytics", null], ["jQuery", "1.12.4"], ["PHP", null], ["Tawk", null], ["WordPress", "6.4.2"]]);
    expect(t.find((x) => x.name === "Tawk")?.categories).toEqual(["Live chat"]);
  });

  it("skips rules that need a browser, honours requires, and ignores invalid patterns", () => {
    expect(run('<body><a href="/cart">Cart</a> wp-plugin-x ([unclosed</body>').map((x) => x.name)).toEqual(["Cart"]);
  });
});

describe("website audit (§6.4)", () => {
  it("SPA guard: an empty app shell is client-rendered and asserts no absences", () => {
    const shell = page('<html><head><meta name="viewport" content="x"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    expect(isClientRendered(shell.$, shell.text)).toBe(true);
    const a = audit([shell]);
    expect(a.clientRendered).toBe(true);
    expect([a.gate3.noAboveFoldCta, a.gate3.noSocialProof, a.gate3.noJsonLd, a.gate4, a.pain.mailtoOnly, a.pain.noScheduling]).toEqual([null, null, null, null, null, null]);
  });

  it("flags a dated, mailto-only clinic site with PDF intake forms and no booking", () => {
    const home = page(`<html><body><table><tr><td><table><tr><td>
      <a href="/about">About us</a><p>${words(260)}</p>
      <a href="mailto:Info@clinic.example">Email us</a> <a href="mailto:dr.ravi@clinic.example">Dr Ravi</a>
      <a href="/forms/New-Patient-Registration.pdf">Download</a> <a href="/brochure.pdf">Our brochure</a>
      <a href="tel:+971 4 123 4567">Call</a>
      <p>© 2019 Clinic</p></td></tr></table></td></tr></table></body></html>`);
    const a = audit([home]);
    expect(a.gate2).toMatchObject({ tableLayout: true, missingViewport: true, copyrightYear: 2019, staleCopyright: true, wallOfText: true });
    expect(a.pain.pdfForms).toEqual([{ url: "https://acme.example/forms/New-Patient-Registration.pdf", label: "New-Patient-Registration.pdf" }]);
    expect(a.pain).toMatchObject({ mailtoOnly: true, noScheduling: true });
    expect(a.gate4).toBe("missing_whatsapp_cta");
    expect(a.gate3).toMatchObject({ noAboveFoldCta: false, noSocialProof: true, noJsonLd: true, noLlmsTxt: true });
    // §6.5: role mailbox kept, the doctor's personal address never.
    expect(a.contacts).toEqual({ emails: ["info@clinic.example"], whatsapp: [], phones: ["+97141234567"], sourceUrl: "https://acme.example/" });
  });

  it("a modern site with a form, booking, WhatsApp widget and reviews has no pain flags", () => {
    const home = page(`<html><head><meta name="viewport" content="width=device-width">
      <script type="application/ld+json">{}</script><script src="https://cdn.joinchat.example/joinchat.min.js"></script></head>
      <body><a href="/book">Book an appointment</a><a href="https://wa.me/971501234567">Chat</a>
      <form><input name="name"><input name="email"><textarea name="msg"></textarea><input type="submit"></form>
      <section>What our patients say</section><p>© 2026</p></body></html>`);
    const a = audit([home], { hasLlmsTxt: true });
    expect(a.pain).toEqual({ pdfForms: [], mailtoOnly: false, noScheduling: false });
    expect(a.gate4).toBe("automated_or_na");
    expect(a.gate2.staleCopyright).toBe(false);
    expect(a.gate3).toMatchObject({ noSocialProof: false, noJsonLd: false, noLlmsTxt: false, longForm: false });
    expect(a.contacts.whatsapp).toEqual(["+971501234567"]);
  });

  it("raw wa.me link without a chat widget; US sites skip the WhatsApp gate", () => {
    const home = page('<body><a href="https://wa.me/919812345678?text=hi">WhatsApp us</a></body>');
    expect(audit([home]).gate4).toBe("raw_wa_link");
    expect(audit([home], { country: "us" }).gate4).toBe("automated_or_na");
  });

  it("Gate 1: inbound vertical, ad pixels or 600+ words of content", () => {
    const thin = page("<body><p>Freight forwarding.</p></body>");
    expect(audit([thin], { vertical: "logistics" }).gate1).toEqual({ dependsOnWebsite: false, reasons: [], serviceWords: 2 });
    expect(audit([thin], { vertical: "healthcare" }).gate1.reasons).toEqual(["inbound_vertical"]);
    const pixel = page('<head><script src="https://connect.facebook.net/en_US/fbevents.js"></script></head><body>x</body>');
    expect(audit([pixel], { vertical: "logistics" }).gate1.reasons).toEqual(["ad_pixels"]);
    expect(audit([page(`<body><main>${words(620)}</main></body>`)], { vertical: "logistics" }).gate1.reasons).toEqual(["service_content"]);
  });

  it("legacy jQuery and Bootstrap come from the tech stack; 8+ field forms are long", () => {
    const tech: Tech[] = [
      { name: "jQuery", version: "1.12.4", categories: [], saas: false },
      { name: "Bootstrap", version: "5.3.0", categories: [], saas: false },
    ];
    const form = page(`<body><form>${'<input name="f">'.repeat(8)}<input type="hidden"><input type="submit"></form></body>`);
    const a = audit([form], { tech });
    expect(a.gate2.legacyLibs).toEqual(["jQuery 1.12.4"]);
    expect(a.gate3).toMatchObject({ maxFormFields: 8, longForm: true });
  });
});

describe("robots.txt AI crawlers", () => {
  it("reads per-bot groups, grouped agents and the * fallback", () => {
    expect(blockedBots("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin")).toEqual(["GPTBot", "ClaudeBot"]);
    expect(blockedBots("User-agent: *\nDisallow: /")).toHaveLength(8);
    expect(blockedBots("User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /")).not.toContain("GPTBot");
    expect(blockedBots(null)).toEqual([]);
  });
});

describe("linked pages to fetch", () => {
  it("one contact, services and careers page on the same site; no files or other sites", () => {
    const $ = parseHtml(`<a href="https://other.example/contact">x</a><a href="/files/contact.pdf">Contact PDF</a>
      <a href="/contact-us#form">Contact</a><a href="/contact">Contact again</a><a href="https://www.acme.example/what-we-do">Services</a>
      <a href="mailto:info@acme.example">Mail</a><a href="/careers">Join us</a><a href="/blog">Blog</a>`);
    expect(pickLinks($, "https://acme.example/")).toEqual(["https://acme.example/contact-us", "https://www.acme.example/what-we-do", "https://acme.example/careers"]);
  });
});

describe("forms the HTML doesn't show", () => {
  it("a form builder in the stack or a hosted form link means the site has a form", () => {
    const home = page('<body><a href="mailto:info@acme.example">Email</a></body>');
    expect(audit([home]).pain.mailtoOnly).toBe(true);
    const ninja: Tech[] = [{ name: "Ninja Forms", version: null, categories: ["Form builders"], saas: false }];
    expect(audit([home], { tech: ninja }).pain.mailtoOnly).toBe(false);
    const typeform = page('<body><a href="mailto:info@acme.example">Email</a><a href="https://acme.typeform.com/to/x">Contact form</a></body>');
    expect(audit([typeform]).pain.mailtoOnly).toBe(false);
  });
});
