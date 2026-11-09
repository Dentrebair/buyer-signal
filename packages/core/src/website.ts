// Website sniff analysis (PRD §5.4, §6.1, §6.4, §6.5). Deterministic and free: input is the
// HTML a plain fetch returned, output is the 4-Gate audit, pain flags and business contacts.
// When the site is client-rendered (SPA guard) every "absence of X" finding is null, never
// true: an empty shell proves nothing is missing.
import { type CheerioAPI, load } from "cheerio";
import type { Tech } from "./techstack.ts";
import { webUrl } from "./text.ts";
import type { Country, VerticalSlug } from "./verticals.ts";

export const parseHtml = (html: string): CheerioAPI => load(html);

// Visible text of the page (scripts, styles and hidden templates removed). Doesn't change $.
export function visibleText($: CheerioAPI): string {
  const body = $("body").clone();
  body.find("script, style, noscript, svg, template, iframe").remove();
  return body.text().replace(/\s+/g, " ").trim();
}

// §6.1: the content without chrome, for word counts and later keyword matching. < 10 KB.
export function minifiedText($: CheerioAPI): string {
  const body = $("body").clone();
  body.find("script, style, noscript, svg, template, iframe, nav, footer, header").remove();
  return body.text().replace(/\s+/g, " ").trim().slice(0, 10_000);
}

// §5.4 step 2: an empty app shell.
export function isClientRendered($: CheerioAPI, text: string): boolean {
  return text.length < 100 && $("div#root, div#__next, app-root").length > 0;
}

// Up to 3 same-site pages to fetch next: contact, services, careers (§5.4 step 1).
const LINK_KINDS = [
  ["contact", /contact|reach[-_ ]?us|get[-_ ]in[-_ ]touch|enquir|inquir/i],
  ["services", /services?\b|what[-_ ]we[-_ ]do|solutions|our[-_ ]work|products?\b/i],
  ["careers", /careers?|jobs?\b|join[-_ ]us|work[-_ ]with[-_ ]us/i],
] as const;
export function pickLinks($: CheerioAPI, pageUrl: string): string[] {
  const base = new URL(pageUrl);
  const host = base.hostname.replace(/^www\./, "");
  const out: string[] = [];
  for (const [, re] of LINK_KINDS) {
    for (const el of $("a[href]").toArray()) {
      let u: URL;
      try {
        u = new URL($(el).attr("href")!, base);
      } catch {
        continue;
      }
      if ((u.protocol !== "https:" && u.protocol !== "http:") || u.hostname.replace(/^www\./, "") !== host) continue;
      if (/\.(pdf|jpe?g|png|gif|webp|docx?|xlsx?|zip)$/i.test(u.pathname)) continue;
      u.hash = "";
      const href = u.toString();
      if (href === base.toString() || out.includes(href)) continue;
      if (re.test(u.pathname) || re.test($(el).text())) {
        out.push(href);
        break;
      }
    }
  }
  return out;
}

export interface SitePage {
  url: string;
  $: CheerioAPI;
  text: string; // visibleText($)
}

export interface SiteInput {
  pages: SitePage[]; // homepage first
  tech: Tech[];
  robotsTxt: string | null;
  hasLlmsTxt: boolean;
  vertical: VerticalSlug | null;
  country: Country | null;
  now: Date;
}

export type WhatsappGate = "missing_whatsapp_cta" | "raw_wa_link" | "automated_or_na";

export interface SiteAudit {
  clientRendered: boolean;
  gate1: { dependsOnWebsite: boolean; reasons: string[]; serviceWords: number };
  gate2: { tableLayout: boolean; missingViewport: boolean; copyrightYear: number | null; staleCopyright: boolean; wallOfText: boolean; legacyLibs: string[] };
  gate3: { maxFormFields: number; longForm: boolean; noAboveFoldCta: boolean | null; noSocialProof: boolean | null; noJsonLd: boolean | null; aiBotsBlocked: string[]; noLlmsTxt: boolean };
  gate4: WhatsappGate | null;
  pain: { pdfForms: { url: string; label: string }[]; mailtoOnly: boolean | null; noScheduling: boolean | null };
  contacts: { emails: string[]; whatsapp: string[]; phones: string[]; sourceUrl: string | null };
}

// Gate 1: verticals where buyers research and enquire online before they call.
export const INBOUND_VERTICALS = new Set<VerticalSlug>([
  "real_estate", "accounting", "healthcare", "legal", "professional_services", "retail_ecommerce", "insurance",
  "lending_finance", "travel", "education", "field_services", "automotive",
]);
// "No scheduling" only means something where customers book time.
export const APPOINTMENT_VERTICALS = new Set<VerticalSlug>(["healthcare", "legal", "field_services", "automotive", "education", "real_estate"]);

const ROLE_MAILBOX = /^(info|sales|contact|contactus|hello|enquiry|enquiries|inquiry|inquiries|support|office|admin|ops|operations|accounts|billing|bookings?|reservations|appointments|reception|service|services|help|team|mail|marketing|careers|jobs|hr|recruitment)$/i;
const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "anthropic-ai", "PerplexityBot", "Google-Extended", "CCBot"];
const CTA = /contact|call|book|appointment|quote|enquir|inquir|get started|schedule|whatsapp|request|demo|consult|apply|order|buy|shop|free/i;
const SOCIAL_PROOF = /testimonial|what (?:our )?(?:clients|customers|patients|students) say|\breviews?\b|trusted by|our clients|case stud|★|rated \d|google rating/i;
const PDF_FORM = /form|application|apply|intake|registration|register|enrol|admission|order|questionnaire|booking|request|claim|consent|referral|patient|onboard|kyc/i;
const BOOKING = /\bbook\b|booking|appointment|schedule|reserve|reservation|calendly/i;
const WA_LINK = /(?:wa\.me\/|api\.whatsapp\.com\/send|web\.whatsapp\.com\/send|wa\.link\/|^whatsapp:)/i;
// Hosted form services, linked or embedded: the business does have a form.
const FORM_SERVICE = /typeform\.com|jotform|hsforms|forms\.hubspot|formstack|wufoo|cognitoforms|tally\.so|forms\.gle|docs\.google\.com\/forms|forms\.office\.com|forms\.zohopublic|paperform|123formbuilder|formsite|fillout\.com/i;
const WA_WIDGET = /joinchat|wati\.io|interakt|gallabox|aisensy|elfsight|getbutton|callbell|tidio|respond\.io|zoko|whatsapp[-_]?(?:widget|chat|button)|chaty|click-to-chat|wa-widget/i;

export function auditSite(x: SiteInput): SiteAudit {
  const home = x.pages[0]!;
  const all = x.pages;
  const spa = isClientRendered(home.$, home.text);
  const absent = (v: boolean) => (spa ? null : v);
  const techNames = new Set(x.tech.map((t) => t.name));
  const techCats = new Set(x.tech.flatMap((t) => t.categories));
  const anchors = all.flatMap((p) => p.$("a[href]").toArray().map((el) => ({ page: p.url, href: p.$(el).attr("href")!.trim(), text: p.$(el).text().replace(/\s+/g, " ").trim() })));
  const scriptSrcs = all.flatMap((p) => p.$("script[src]").toArray().map((el) => p.$(el).attr("src") ?? ""));

  // Gate 1 — does this business depend on its website?
  const serviceWords = Math.max(...all.map((p) => wordCount(minifiedText(p.$))));
  const adPixels = scriptSrcs.some((s) => /fbevents\.js|connect\.facebook\.net|googletagmanager\.com\/gtag\/js|googleadservices/i.test(s)) || techNames.has("Facebook Pixel");
  const reasons = [
    ...(x.vertical && INBOUND_VERTICALS.has(x.vertical) ? ["inbound_vertical"] : []),
    ...(adPixels ? ["ad_pixels"] : []),
    ...(serviceWords >= 600 ? ["service_content"] : []),
  ];

  // Gate 2 — outdated UI (heuristics only, no vision in v1).
  const copyrightYear = copyright(all.map((p) => p.text).join(" "), x.now);
  const legacyLibs = x.tech
    .filter((t) => (t.name === "jQuery" && major(t.version) !== null && major(t.version)! < 3) || (t.name === "Bootstrap" && major(t.version) !== null && major(t.version)! < 4))
    .map((t) => `${t.name} ${t.version}`);

  // Gate 3 — conversion and AEO/GEO.
  const maxFormFields = Math.max(0, ...all.flatMap((p) => p.$("form").toArray().map((f) => fields(p.$, f))));
  const firstActions = home.$("a[href], button").toArray().slice(0, 40);
  const aboveFoldCta = firstActions.some((el) => {
    const $el = home.$(el);
    return CTA.test($el.text()) || /^(tel:|mailto:)/i.test($el.attr("href") ?? "") || WA_LINK.test($el.attr("href") ?? "");
  });
  const socialProof = all.some((p) => SOCIAL_PROOF.test(p.text)) || techCats.has("Reviews");
  const jsonLd = all.some((p) => p.$('script[type="application/ld+json"]').length > 0);

  // Gate 4 — WhatsApp wedge (IN / UAE, where customers message businesses on WhatsApp).
  const waLinks = anchors.filter((a) => WA_LINK.test(a.href));
  const chatWidget = scriptSrcs.some((s) => WA_WIDGET.test(s)) || x.tech.some((t) => t.categories.includes("Live chat") && t.name !== "WhatsApp Business Chat");
  const gate4: WhatsappGate | null =
    x.country === "us" ? "automated_or_na" : waLinks.length ? (chatWidget ? "automated_or_na" : "raw_wa_link") : chatWidget ? "automated_or_na" : spa ? null : "missing_whatsapp_cta";

  // Pain flags: manual intake the business runs today.
  const pdfForms = uniqBy(
    anchors
      .filter((a) => /\.pdf(?:$|[?#])/i.test(a.href) && (PDF_FORM.test(a.text) || PDF_FORM.test(a.href)))
      .flatMap((a) => {
        const url = absolute(a.href, a.page);
        return url ? [{ url, label: PDF_FORM.test(a.text) ? a.text.slice(0, 120) : fileName(a.href) }] : [];
      }),
    (p) => p.url,
  ).slice(0, 5);
  const hasMailto = anchors.some((a) => /^mailto:/i.test(a.href));
  const embeds = all.flatMap((p) => p.$("iframe[src]").toArray().map((el) => p.$(el).attr("src") ?? ""));
  const hasForm =
    all.some((p) => p.$("form").toArray().some((f) => fields(p.$, f) >= 2)) ||
    techCats.has("Form builders") || // e.g. Ninja Forms, rendered by script after load
    [...anchors.map((a) => a.href), ...embeds, ...scriptSrcs].some((u) => FORM_SERVICE.test(u));
  const booking = techCats.has("Appointment scheduling") || techCats.has("Reservations & delivery") || anchors.some((a) => BOOKING.test(a.text) || BOOKING.test(a.href));

  return {
    clientRendered: spa,
    gate1: { dependsOnWebsite: reasons.length > 0, reasons, serviceWords },
    gate2: {
      tableLayout: all.some((p) => p.$("table table").length > 0 || p.$("body > table").length > 0),
      missingViewport: home.$('meta[name="viewport"]').length === 0,
      copyrightYear,
      staleCopyright: copyrightYear !== null && copyrightYear < x.now.getUTCFullYear() - 3,
      wallOfText: all.some((p) => p.$("p").toArray().some((el) => wordCount(p.$(el).text()) >= 250)),
      legacyLibs,
    },
    gate3: {
      maxFormFields,
      longForm: maxFormFields >= 8,
      noAboveFoldCta: absent(!aboveFoldCta),
      noSocialProof: absent(!socialProof),
      noJsonLd: absent(!jsonLd),
      aiBotsBlocked: blockedBots(x.robotsTxt),
      noLlmsTxt: !x.hasLlmsTxt,
    },
    gate4,
    pain: {
      pdfForms,
      mailtoOnly: absent(hasMailto && !hasForm),
      noScheduling: x.vertical && APPOINTMENT_VERTICALS.has(x.vertical) ? absent(!booking) : false,
    },
    contacts: contacts(all, anchors),
  };
}

// §6.5: role mailboxes, business WhatsApp and phone links only. Never a person's address.
function contacts(pages: SitePage[], anchors: { page: string; href: string }[]): SiteAudit["contacts"] {
  const emails = new Map<string, string>();
  const add = (raw: string, page: string) => {
    const e = raw.toLowerCase().replace(/^mailto:/, "").split("?")[0]!.trim();
    const m = e.match(/^([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/);
    if (m && ROLE_MAILBOX.test(m[1]!) && !emails.has(e)) emails.set(e, page);
  };
  for (const a of anchors) if (/^mailto:/i.test(a.href)) add(a.href, a.page);
  for (const p of pages) for (const m of p.text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) add(m[0], p.url);
  const whatsapp = uniq(anchors.map((a) => waNumber(a.href)).filter((n): n is string => !!n));
  const phones = uniq(anchors.filter((a) => /^tel:/i.test(a.href)).map((a) => a.href.slice(4).replace(/[^\d+]/g, "")).filter((n) => n.replace(/\D/g, "").length >= 7));
  const first = emails.values().next().value ?? anchors.find((a) => waNumber(a.href) || /^tel:/i.test(a.href))?.page ?? null;
  return { emails: [...emails.keys()].slice(0, 5), whatsapp: whatsapp.slice(0, 3), phones: phones.slice(0, 3), sourceUrl: first };
}

function waNumber(href: string): string | null {
  const m = href.match(/wa\.me\/\+?(\d{7,15})/i) ?? href.match(/[?&]phone=\+?(\d{7,15})/i);
  return m ? `+${m[1]}` : null;
}

// robots.txt groups that disallow the whole site for an AI crawler (or for everyone).
export function blockedBots(robots: string | null): string[] {
  if (!robots) return [];
  const groups: { agents: string[]; disallowAll: boolean }[] = [];
  let cur: { agents: string[]; disallowAll: boolean } | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], disallowAll: false }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && key === "disallow" && val === "/") cur.disallowAll = true;
    }
  }
  return AI_BOTS.filter((bot) => {
    const own = groups.find((g) => g.agents.includes(bot.toLowerCase()));
    return own ? own.disallowAll : groups.some((g) => g.agents.includes("*") && g.disallowAll);
  });
}

function fields($: CheerioAPI, form: Parameters<CheerioAPI>[0]): number {
  return $(form).find("input, select, textarea").toArray().filter((el) => !/^(hidden|submit|button|reset|image)$/i.test($(el).attr("type") ?? "")).length;
}

function copyright(text: string, now: Date): number | null {
  const years = [...text.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–—]\s*)?((?:19|20)\d{2})/gi)].map((m) => Number(m[1])).filter((y) => y <= now.getUTCFullYear());
  return years.length ? Math.max(...years) : null;
}

const wordCount = (s: string) => (s.match(/\p{L}[\p{L}'’-]*/gu) ?? []).length;
const major = (v: string | null) => (v && /^\d+/.test(v) ? Number(v.match(/^\d+/)![0]) : null);
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const uniqBy = <T>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];
const fileName = (href: string) => decodeURIComponent(href.split(/[?#]/)[0]!.split("/").pop() ?? href).slice(0, 120);
// An absolute http(s) link, or null: a page's href can be javascript: or data: (and still end in .pdf).
function absolute(href: string, page: string): string | null {
  try {
    return webUrl(new URL(href, page).toString());
  } catch {
    return null;
  }
}

// §5.4 steps 3–4: which findings become scored challenges. Website signals score 44 (dom_sniff)
// or 40 (tech_stack) and add the "website" family to M; Gates 2–3 findings are audit-only.
export interface WebsiteSignal {
  sourceType: "dom_sniff" | "tech_stack";
  evidence: string; // challenges.evidence_snippet: title line, blank line, details
}

const SILO_CATEGORIES = new Set(["Form builders", "CRM", "Appointment scheduling", "Live chat", "Marketing automation", "Email", "Surveys"]);

export function websiteSignals(a: SiteAudit, tech: Tech[]): WebsiteSignal[] {
  const out: WebsiteSignal[] = [];
  const intake = [
    ...a.pain.pdfForms.map((f) => `PDF form to print and fill: ${f.label} (${f.url})`),
    ...(a.pain.mailtoOnly ? ["Enquiries only through an email link, no form"] : []),
    ...(a.pain.noScheduling ? ["No online booking"] : []),
  ];
  if (intake.length) out.push({ sourceType: "dom_sniff", evidence: `Website: manual intake\n\n${intake.join("\n")}` });

  const silos = tech.filter((t) => t.saas && t.categories.some((c) => SILO_CATEGORIES.has(c)));
  if (silos.length >= 3)
    out.push({ sourceType: "tech_stack", evidence: `Website: ${silos.length} separate customer tools\n\n${silos.map((t) => `${t.name} (${t.categories.join(", ")})`).join("\n")}` });
  return out;
}
