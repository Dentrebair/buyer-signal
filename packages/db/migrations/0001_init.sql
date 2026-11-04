-- 0001_init: schema from PRD-v3 §11 (copied verbatim), then RLS and grants.

create extension if not exists pgcrypto;
create extension if not exists vector;

create table companies (
  id uuid primary key default gen_random_uuid(),
  domain text unique not null,
  company_name text,
  vertical text,
  country text,
  contact_email text,            -- role mailbox only
  contact_whatsapp text,         -- public business number only
  contact_source_url text,
  founder_name text,             -- founder/owner only (Q49a)
  founder_email text,            -- only if publicly listed by them or on the company site
  founder_source_url text,
  reachable boolean,
  is_client_rendered boolean not null default false,
  employee_band text,            -- e.g. '11-50', as reported
  size_tier text check (size_tier in ('smb','midsize','startup','growth','unknown')),
  size_source text check (size_source in
    ('job_board','search_snippet','llm_brand','domain_age','none')),
  founded_year integer,          -- only if a source states it; never derived from domain age
  domain_registered_at date,     -- RDAP registration date (Q57: tags Startup/Growth only)
  tech_stack jsonb not null default '[]',
  structural_flags jsonb not null default '{}',
  web_ui_audit_flags jsonb not null default '{}',
  company_dossier_summary jsonb not null default '{}',
  priority_score integer not null default 0 check (priority_score between 0 and 100),
  score_breakdown jsonb not null default '{}',
  status text not null default 'new' check (status in ('new','actioned','rejected')),
  rejection_reason text check (rejection_reason in
    ('wrong_company','not_real_pain','too_small','already_client','other')),
  rejected_score integer,
  rejected_families jsonb not null default '[]',
  has_unverified_inbound boolean not null default false,
  resurfaced_at timestamptz,
  outreach_drafts jsonb,
  draft_stale boolean not null default false,
  draft_generated_at timestamptz,
  last_sniffed_at timestamptz,
  actioned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_companies_board on companies (status, priority_score desc, updated_at desc);

create table challenges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  source_type text not null check (source_type in
    ('job_post','linkedin_post','social_post','dom_sniff','tech_stack','inbound')),
  source_family text generated always as (
    case when source_type in ('dom_sniff','tech_stack') then 'website' else source_type end
  ) stored,
  natural_id text unique,
  source_url text,
  evidence_confidence integer not null,
  buying_intent integer not null,
  blast_radius integer not null default 0 check (blast_radius between 0 and 30),
  signal_score integer not null check (signal_score between 0 and 100),
  department text not null default 'Unknown',
  posted_at timestamptz,          -- signal's own publish date (§4.3); null only for inbound
  evidence_snippet text not null check (char_length(evidence_snippet) <= 2000),
  matched_keywords jsonb not null default '[]',
  semantic_nodes jsonb not null default '[]',
  structured_intelligence jsonb,   -- null for structural signals
  llm_model text,                  -- model slug that produced structured_intelligence
  inbound_verified boolean,
  author_relation text check (author_relation in
    ('founder_owner','employee','company_page')),   -- LinkedIn/Reddit only (Q59)
  author_name text,                -- founder_owner only (Q49); never for employee (Q61)
  author_role text,                -- founder_owner only
  author_email text,               -- founder_owner only, if in the post itself
  created_at timestamptz not null default now()
);
create index idx_challenges_company on challenges (company_id, created_at desc);

create table seed_urls (
  id uuid primary key default gen_random_uuid(),
  domain text unique not null,
  company_id uuid references companies(id) on delete cascade,
  origin text not null check (origin in ('job_post','linkedin_post','social_post','inbound')),
  status text not null default 'pending'
    check (status in ('pending','processing','done','unreachable','failed')),
  attempts integer not null default 0,
  last_error text,
  attempted_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_seed_urls_pending on seed_urls (status, created_at);

create table ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  vertical text,
  country text,
  apify_run_id text,
  status text not null default 'running',
  raw_items_ingested integer not null default 0,
  dropped_stale_count integer not null default 0,
  dropped_dedup_count integer not null default 0,
  dropped_trie_count integer not null default 0,
  dropped_recruiter_count integer not null default 0,
  dropped_unresolved_count integer not null default 0,
  dropped_size_count integer not null default 0,
  dropped_stance_count integer not null default 0,
  dropped_no_fit_count integer not null default 0,
  llm_persisted_count integer not null default 0,
  estimated_cost_usd numeric(8,4) not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table spend_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('apify','brave','openrouter','gemini')),
  model text,                    -- LLM model slug, when provider = 'openrouter'
  units numeric not null,
  cost_usd numeric(10,6) not null,
  run_id uuid references ingestion_runs(id) on delete set null,
  ref text,
  created_at timestamptz not null default now()
);
create index idx_spend_events_month on spend_events (created_at);

-- Q63: Postgres in place of Redis
create table seen_items (
  natural_id text primary key,        -- 'job:<id>', 'post:<url>', …
  expires_at timestamptz not null
);
create index idx_seen_items_expiry on seen_items (expires_at);

create table domain_cache (
  key text primary key,               -- '<normalized_name>:<city|vertical>'
  domain text,                        -- null = cached miss
  expires_at timestamptz not null     -- hit 30 d, miss 7 d
);

create table spend_counters (
  key text primary key,               -- 'month:2026-11', 'apify:2026-10-16'
  total_usd numeric(10,6) not null default 0,
  cap_usd numeric(10,2) not null,
  updated_at timestamptz not null default now()
);

create table rate_hits (
  bucket text not null,               -- 'roast:<ip>'
  hit_at timestamptz not null default now()
);
create index idx_rate_hits on rate_hits (bucket, hit_at);
-- Daily cleanup job deletes expired seen_items / domain_cache rows and rate_hits older than 1 day.

-- Sprint 4: trend_clusters and macro_trends as in v2.1 §10 (vector(768), HNSW m=16, ef_construction=64).

-- updated_at maintenance
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger trg_companies_updated before update on companies
  for each row execute function set_updated_at();

-- ── RLS (PRD §11) ────────────────────────────────────────────────────────────
-- The worker uses the service role (bypasses RLS). The operator signs in as `authenticated`.
-- `anon` gets nothing.
do $$
declare t text;
begin
  foreach t in array array['companies','challenges','seed_urls','ingestion_runs','spend_events',
                           'seen_items','domain_cache','spend_counters','rate_hits'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
  -- Operator can read the board and telemetry tables.
  foreach t in array array['companies','challenges','seed_urls','ingestion_runs','spend_events','spend_counters'] loop
    execute format('grant select on %I to authenticated', t);
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;

-- Operator may only change status, rejection_reason, actioned_at on companies.
grant update (status, rejection_reason, actioned_at) on companies to authenticated;
create policy companies_operator_update on companies for update to authenticated
  using (true) with check (true);
-- seen_items, domain_cache, rate_hits: service role only (no policies, no grants).
