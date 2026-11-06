-- 0006: ingest-rotation (PRD §4.1). One row per UTC day records the slots that day's cron
-- planned; the insert is the claim, so a retried cron job never starts a second set of runs.
create table rotation_days (
  day date primary key,
  slots jsonb not null,
  created_at timestamptz not null default now()
);
-- Which search title a board run used (rotation cycles through each vertical's titles).
alter table ingestion_runs add column query_title text;

alter table rotation_days enable row level security;
revoke all on rotation_days from anon, authenticated;
grant select on rotation_days to authenticated;
create policy rotation_days_read on rotation_days for select to authenticated using (true);
