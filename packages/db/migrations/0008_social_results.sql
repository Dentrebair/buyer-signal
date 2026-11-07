-- 0008: every Social digest search result and what happened to it, so the Sources page can list
-- a run's posts with their verdict. Kept 21 days (the post window), then purged by poll-runs.
-- Never holds the result title (the author's name): the snippet and post URL only (§4.1a).
create table social_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ingestion_runs(id) on delete cascade,
  url text not null,
  snippet text not null default '',
  posted_at timestamptz,
  outcome text not null check (outcome in
    ('not_post','stale','seen','recruiter','checking','stance','no_company','no_fit','too_large','card')),
  author_relation text,
  stance text,
  symptom text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, url)
);
create index idx_social_results_run on social_results (run_id);
create trigger trg_social_results_updated before update on social_results
  for each row execute function set_updated_at();
alter table social_results enable row level security;
revoke all on social_results from anon, authenticated;
grant select on social_results to authenticated;
create policy social_results_read on social_results for select to authenticated using (true);
