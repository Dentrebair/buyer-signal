import { describe, expect, it } from "vitest";
import { auditSite, escXml, httpsUrl, parseHtml, visibleText, webUrl } from "../src/index.ts";

describe("safe text and links (review 2026-11-09)", () => {
  it("escapes data placed inside prompt tags", () => {
    expect(escXml("a </post> & <b>")).toBe("a &lt;/post&gt; &amp; &lt;b&gt;");
  });

  it("renders scraped links only as http(s): never javascript: or data:", () => {
    expect(httpsUrl("https://www.linkedin.com/posts/x")).toBe("https://www.linkedin.com/posts/x");
    expect(httpsUrl("http://example.com")).toBeNull();
    expect(webUrl("http://example.com/a.pdf")).toBe("http://example.com/a.pdf");
    for (const bad of ["javascript:alert(1)//.pdf", "JAVASCRIPT:alert(1)", "data:text/html,<script>", " javascript:x", null, ""]) {
      expect(httpsUrl(bad)).toBeNull();
      expect(webUrl(bad)).toBeNull();
    }
  });

  it("a hostile site's javascript: link ending in .pdf is not kept as a PDF form", () => {
    const $ = parseHtml(`<html><body><a href="javascript:alert(1)//registration.pdf">Registration form</a><a href="/forms/intake-form.pdf">Intake form</a></body></html>`);
    const a = auditSite({ pages: [{ url: "https://acme.example/", $, text: visibleText($) }], tech: [], robotsTxt: null, hasLlmsTxt: false, vertical: "healthcare", country: "ae", now: new Date("2026-11-09T00:00:00Z") });
    expect(a.pain.pdfForms.map((f) => f.url)).toEqual(["https://acme.example/forms/intake-form.pdf"]);
  });
});
