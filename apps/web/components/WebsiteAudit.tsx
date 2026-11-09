// Dossier "Website audit" section (PRD §10.2): 4-Gate findings, notable tools, business contacts.
// Shows only what was found; absences on a client-rendered site are unknown, not findings.
import { webUrl } from "@bs/core/text";
import { ArrowSquareOut, Browser, Envelope, Phone, WhatsappLogo } from "@phosphor-icons/react/ssr";
import type { SiteAudit, Tech } from "@bs/core";
import { ageLabel } from "@/lib/labels.ts";
import { Meta } from "./Meta.tsx";

export interface AuditCompany {
  reachable: boolean | null;
  is_client_rendered: boolean;
  last_sniffed_at: string | null;
  tech_stack: (Tech | string)[];
  web_ui_audit_flags: Partial<SiteAudit> & { pages?: string[]; unreachable?: string };
  contact_email: string | null;
  contact_whatsapp: string | null;
  contact_source_url: string | null;
}

// Tools worth a sentence in a pitch; servers, fonts and JS libraries are noise to the operator.
const NOTABLE = new Set([
  "CMS", "Ecommerce", "CRM", "Live chat", "Appointment scheduling", "Reservations & delivery", "Form builders",
  "Marketing automation", "Email", "Accounting", "Payment processors", "Page builders", "Surveys", "LMS", "Ticket booking",
]);

export function WebsiteAudit({ company: c }: { company: AuditCompany }) {
  if (!c.last_sniffed_at) return null;
  const a = c.web_ui_audit_flags;
  const tech = c.tech_stack.map((t) => (typeof t === "string" ? { name: t, version: null, categories: [], saas: false } : t));
  const notable = tech.filter((t) => t.categories.some((cat) => NOTABLE.has(cat)));

  return (
    <section className="card audit" aria-labelledby="audit">
      <h3 id="audit">
        <Browser size={15} aria-hidden /> Website audit
      </h3>
      {c.reachable === false ? (
        <p className="muted">
          {a.unreachable?.startsWith("redirects to another site")
            ? `The website ${a.unreachable}. It may have been sold, rebranded or taken over, so it wasn't audited.`
            : "Couldn't load the website (blocked, timed out or not a website)."}{" "}
          Checked {ageLabel(c.last_sniffed_at)}.
        </p>
      ) : (
        <>
          <Findings a={a} />
          {notable.length > 0 && (
            <div className="audit-block">
              <h4>Tools on the site</h4>
              <ul className="chips">
                {notable.map((t) => (
                  <li key={t.name}>
                    {t.name}
                    {t.version ? ` ${t.version}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Contacts c={c} />
          <Meta
            className="audit-foot"
            items={[
              `Checked ${ageLabel(c.last_sniffed_at)}`,
              <>
                <span className="num">{a.pages?.length ?? 1}</span> page{(a.pages?.length ?? 1) === 1 ? "" : "s"}
              </>,
              <>
                <span className="num">{tech.length}</span> technologies detected
              </>,
            ]}
          />
        </>
      )}
    </section>
  );
}

function Findings({ a }: { a: Partial<SiteAudit> }) {
  const intake: React.ReactNode[] = [];
  // http(s) only: an audit stored before 2026-11-09 may hold a javascript: link from the scraped page.
  for (const f of (a.pain?.pdfForms ?? []).filter((x) => webUrl(x.url)))
    intake.push(
      <>
        PDF form to print and fill:{" "}
        <a href={f.url} target="_blank" rel="noopener noreferrer" className="link">
          {f.label} <ArrowSquareOut size={12} aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </>,
    );
  if (a.pain?.mailtoOnly) intake.push("Enquiries only by email link, no form");
  if (a.pain?.noScheduling) intake.push("No online booking");
  if (a.gate3?.longForm) intake.push(`A form with ${a.gate3.maxFormFields} fields`);

  const whatsapp: React.ReactNode[] = [];
  if (a.gate4 === "missing_whatsapp_cta") whatsapp.push("No WhatsApp button");
  if (a.gate4 === "raw_wa_link") whatsapp.push("Plain WhatsApp link, no chat automation");

  const conversion: React.ReactNode[] = [];
  if (a.gate3?.noAboveFoldCta) conversion.push("No call to action near the top");
  if (a.gate3?.noSocialProof) conversion.push("No reviews or testimonials");
  if (a.gate3?.noJsonLd) conversion.push("No structured data for search and AI answers");
  if (a.gate3?.aiBotsBlocked?.length) conversion.push(`Blocks AI crawlers: ${a.gate3.aiBotsBlocked.join(", ")}`);

  const dated: React.ReactNode[] = [];
  if (a.gate2?.missingViewport) dated.push("Not set up for phones");
  if (a.gate2?.tableLayout) dated.push("Table-based layout");
  if (a.gate2?.staleCopyright) dated.push(`Copyright year ${a.gate2.copyrightYear}`);
  if (a.gate2?.wallOfText) dated.push("Walls of text");
  if (a.gate2?.legacyLibs?.length) dated.push(`Old libraries: ${a.gate2.legacyLibs.join(", ")}`);

  const groups = [
    ["Manual intake", intake],
    ["WhatsApp", whatsapp],
    ["Conversion & AI search", conversion],
    ["Dated design", dated],
  ] as const;
  return (
    <>
      {a.clientRendered && <p className="audit-note">The page builds itself in the browser, so this check saw an empty shell. Missing items aren&apos;t counted.</p>}
      {a.gate1 && (
        <p className="audit-note">
          {a.gate1.dependsOnWebsite
            ? `The website matters to this business (${a.gate1.reasons.map((r) => GATE1[r] ?? r).join(", ")}).`
            : "The website isn't central to this business. Use these findings as a side angle at most."}
        </p>
      )}
      {groups.every(([, items]) => items.length === 0) ? (
        <p className="muted">Nothing to flag on the website.</p>
      ) : (
        <div className="audit-groups">
          {groups.map(([title, items]) =>
            items.length ? (
              <div key={title} className="audit-block">
                <h4>{title}</h4>
                <ul>
                  {items.map((it, i) => (
                    <li key={i}>{it}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>
      )}
    </>
  );
}

const GATE1: Record<string, string> = {
  inbound_vertical: "customers find this kind of business online",
  ad_pixels: "runs ads to the site",
  service_content: "detailed service pages",
};

function Contacts({ c }: { c: AuditCompany }) {
  const a = c.web_ui_audit_flags as Partial<SiteAudit>;
  const emails = a.contacts?.emails ?? (c.contact_email ? [c.contact_email] : []);
  const whatsapp = a.contacts?.whatsapp ?? (c.contact_whatsapp ? [c.contact_whatsapp] : []);
  const phones = a.contacts?.phones ?? [];
  if (!emails.length && !whatsapp.length && !phones.length) return null;
  return (
    <div className="audit-block">
      <h4>Business contacts on the site</h4>
      <ul className="contacts">
        {emails.map((e) => (
          <li key={e}>
            <Envelope size={14} aria-hidden /> <a href={`mailto:${e}`} className="link">{e}</a>
          </li>
        ))}
        {whatsapp.map((w) => (
          <li key={w}>
            <WhatsappLogo size={14} aria-hidden /> {w}
          </li>
        ))}
        {phones.map((p) => (
          <li key={p}>
            <Phone size={14} aria-hidden /> {p}
          </li>
        ))}
      </ul>
    </div>
  );
}
