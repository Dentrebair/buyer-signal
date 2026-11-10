import { describe, expect, it } from "vitest";
import { type SiteAudit, buildRoast, emailMatchesSite, roastDomain, roastEmail, roastFacts } from "../src/index.ts";

const audit = (over: Partial<SiteAudit> = {}): SiteAudit => ({
  clientRendered: false,
  gate1: { dependsOnWebsite: true, reasons: [], serviceWords: 400 },
  gate2: { tableLayout: false, missingViewport: false, copyrightYear: 2026, staleCopyright: false, wallOfText: false, legacyLibs: [] },
  gate3: { maxFormFields: 4, longForm: false, noAboveFoldCta: false, noSocialProof: false, noJsonLd: false, aiBotsBlocked: [], noLlmsTxt: false },
  gate4: null,
  pain: { pdfForms: [], mailtoOnly: false, noScheduling: false },
  contacts: { emails: [], whatsapp: [], phones: [], sourceUrl: null },
  ...over,
});

describe("/roast", () => {
  it("reads the domain from what a visitor types, and refuses what isn't a public site", () => {
    expect(roastDomain("acme.com")).toBe("acme.com");
    expect(roastDomain(" https://WWW.Acme.co.in/about?x=1 ")).toBe("acme.co.in");
    expect(roastDomain("http://shop.acme.com")).toBe("shop.acme.com");
    for (const bad of ["", "acme", "http://127.0.0.1", "https://10.0.0.1/", "localhost", "http://intranet.local", "ftp://acme.com", "javascript:alert(1)", "https://acme.com:8080", "https://u:p@acme.com", "https://[::1]/", "file:///etc/passwd", "acme.example"])
      expect(roastDomain(bad), bad).toBeNull();
  });

  it("emails: valid ones kept lower case; verified only on the site's own domain, never free mail", () => {
    expect(roastEmail(" Jo@Acme.com ")).toBe("jo@acme.com");
    expect(roastEmail("not an email")).toBeNull();
    expect(emailMatchesSite("jo@acme.com", "acme.com")).toBe(true);
    expect(emailMatchesSite("jo@mail.acme.com", "acme.com")).toBe(true);
    expect(emailMatchesSite("jo@acme.com", "shop.acme.com")).toBe(true);
    expect(emailMatchesSite("jo@gmail.com", "gmail.com")).toBe(false);
    expect(emailMatchesSite("jo@notacme.com", "acme.com")).toBe(false);
    expect(emailMatchesSite("jo@other.com", "acme.com")).toBe(false);
  });

  it("the teardown sees only measured facts, escaped; few facts say so", () => {
    const facts = roastFacts(audit({ pain: { pdfForms: [{ url: "https://acme.com/f.pdf", label: "Intake <form>" }], mailtoOnly: true, noScheduling: null } }), []);
    expect(facts).toEqual(["Customers download PDF forms to print and fill: Intake <form>.", "The only way to enquire is an email link; there is no form."]);
    const req = buildRoast({ domain: "acme.com", audit: audit({ pain: { pdfForms: [{ url: "u", label: "Intake <form>" }], mailtoOnly: false, noScheduling: false } }), tech: [] });
    expect(req.user).toContain("Intake &lt;form&gt;");
    expect(req.routerModels?.length).toBeGreaterThan(0);
    expect(buildRoast({ domain: "acme.com", audit: audit(), tech: [] }).user).toContain("<fact>No problems measured.</fact>");
  });

  it("parse: trims, keeps at most 5 findings, an empty headline is a failure", () => {
    const req = buildRoast({ domain: "acme.com", audit: audit(), tech: [] });
    const f = { title: " T ", detail: " D ", fix: " F " };
    const out = req.parse({ headline: " Big problem ", summary: " S ", findings: Array(7).fill(f), quick_win: " Q " });
    expect(out).toMatchObject({ headline: "Big problem", summary: "S", quick_win: "Q" });
    expect(out.findings).toHaveLength(5);
    expect(out.findings[0]).toEqual({ title: "T", detail: "D", fix: "F" });
    expect(() => req.parse({ headline: "  ", summary: "", findings: [], quick_win: "" })).toThrow(/empty/);
  });
});
