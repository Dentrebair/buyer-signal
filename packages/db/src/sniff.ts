// seed_urls → website sniff (PRD §4.2, §5.4). Seeds are claimed in small batches by a cron; each
// claimed seed becomes one sniff-domain job, sent in the same transaction as the claim.
import type pg from "pg";

const STUCK_MINUTES = 60; // a claimed seed whose job never finished is claimed again
const MAX_ATTEMPTS = 3;

export interface ClaimedSeed {
  id: string;
  domain: string;
}

// Pending seeds, oldest first, plus stuck ones. Seeds that used up their attempts → failed.
export async function claimSeeds(c: pg.PoolClient, limit: number): Promise<ClaimedSeed[]> {
  await c.query(
    `update seed_urls set status = 'failed', last_error = coalesce(last_error, 'gave up after ${MAX_ATTEMPTS} attempts')
     where status = 'processing' and attempts >= $1 and attempted_at < now() - make_interval(mins => $2)`,
    [MAX_ATTEMPTS, STUCK_MINUTES],
  );
  const r = await c.query<ClaimedSeed>(
    `update seed_urls set status = 'processing', attempts = attempts + 1, attempted_at = now()
     where id in (
       select id from seed_urls
       where status = 'pending' or (status = 'processing' and attempted_at < now() - make_interval(mins => $2))
       order by created_at limit $1 for update skip locked)
     returning id, domain`,
    [limit, STUCK_MINUTES],
  );
  return r.rows;
}

export interface SeedTarget {
  domain: string;
  company_id: string | null;
  company_name: string | null;
  vertical: string | null;
  country: string | null;
}

export async function seedTarget(db: pg.Pool, seedId: string): Promise<SeedTarget | null> {
  const r = await db.query<SeedTarget>(
    `select s.domain, s.company_id, c.company_name, c.vertical, c.country
     from seed_urls s left join companies c on c.id = s.company_id where s.id = $1`,
    [seedId],
  );
  return r.rows[0] ?? null;
}

export async function finishSeed(db: pg.Pool | pg.PoolClient, seedId: string, status: "done" | "unreachable" | "failed", error?: string) {
  await db.query("update seed_urls set status = $2, last_error = $3 where id = $1", [seedId, status, error ?? null]);
}

export interface SniffSave {
  reachable: boolean;
  clientRendered?: boolean;
  techStack?: object[];
  audit?: object;
  contactEmail?: string | null;
  contactWhatsapp?: string | null;
  contactSourceUrl?: string | null;
}

// The latest sniff replaces the last one; contacts only fill gaps (§6.5: from the site, with source).
export async function saveSniff(c: pg.PoolClient, companyId: string, x: SniffSave) {
  await c.query(
    `update companies set
       reachable = $2,
       is_client_rendered = coalesce($3, is_client_rendered),
       tech_stack = coalesce($4, tech_stack),
       web_ui_audit_flags = coalesce($5, web_ui_audit_flags),
       contact_source_url = case when contact_email is null and contact_whatsapp is null and ($6::text is not null or $7::text is not null)
                                 then $8 else contact_source_url end,
       contact_email = coalesce(contact_email, $6),
       contact_whatsapp = coalesce(contact_whatsapp, $7),
       last_sniffed_at = now(),
       updated_at = now()
     where id = $1`,
    [
      companyId,
      x.reachable,
      x.clientRendered ?? null,
      x.techStack ? JSON.stringify(x.techStack) : null,
      x.audit ? JSON.stringify(x.audit) : null,
      x.contactEmail ?? null,
      x.contactWhatsapp ?? null,
      x.contactSourceUrl ?? null,
    ],
  );
}
