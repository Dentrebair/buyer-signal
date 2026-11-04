-- 0004: resolve queue (§5.1 step 5c). Extracted posts with no website from the board or the
-- cache wait here; a daily job searches the highest-scoring ones up to SEARCH_DAILY_CAP.
-- `payload` holds the extract-llm job plus the extraction output, so a resolved post becomes a
-- card without a second LLM call.
create table resolve_queue (
  natural_id text primary key,
  run_id uuid references ingestion_runs(id) on delete set null,
  cache_key text not null,
  company_name text not null,
  city text,
  country text not null,
  provisional_score integer not null,
  posted_at timestamptz,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','resolved','unresolved','stale')),
  searched_at timestamptz,              -- set when a paid search ran for this row (daily quota)
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index idx_resolve_queue_pending on resolve_queue (provisional_score desc, created_at) where status = 'pending';
create index idx_resolve_queue_searched on resolve_queue (searched_at) where searched_at is not null;

-- Service role only, like domain_cache.
alter table resolve_queue enable row level security;
revoke all on resolve_queue from anon, authenticated;
