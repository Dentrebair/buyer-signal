-- 0023: daily alerts (Q65): what the day's check found, and whether it was emailed.
create table alerts (
  day date not null,
  kind text not null check (kind in ('apify_budget', 'ai_budget', 'failed_runs', 'dead_jobs', 'no_cards', 'drift')),
  message text not null,
  emailed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (day, kind)
);
alter table alerts enable row level security;
revoke all on alerts from anon, authenticated;
grant select on alerts to authenticated;
create policy alerts_read on alerts for select to authenticated using (true);
