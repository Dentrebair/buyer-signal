-- 0011: the search bandit (PRD §4.1c). One row per search (arm); runs link to the arms they
-- used; a card records its run, so an operator rejection counts against the search that found it.
create table search_arms (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('job', 'social')),
  vertical text,                         -- null: a fixer-hire search, any vertical
  country text not null,
  term text not null,                    -- the job title or the social topic
  grp text not null check (grp in ('high', 'medium', 'low')),
  source text not null default 'seed' check (source in ('seed', 'manual', 'learned', 'ai')),
  status text not null default 'active' check (status in ('active', 'retired')),
  retired_at timestamptz,
  revived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index uq_search_arms on search_arms (kind, coalesce(vertical, ''), country, lower(term));

create table run_arms (
  run_id uuid not null references ingestion_runs(id) on delete cascade,
  arm_id uuid not null references search_arms(id) on delete cascade,
  primary key (run_id, arm_id)
);
create index idx_run_arms_arm on run_arms (arm_id);

alter table challenges add column run_id uuid references ingestion_runs(id) on delete set null;
create index idx_challenges_run on challenges (run_id);

alter table search_arms enable row level security;
alter table run_arms enable row level security;
revoke all on search_arms, run_arms from anon, authenticated;
grant select on search_arms, run_arms to authenticated;
create policy search_arms_read on search_arms for select to authenticated using (true);
create policy run_arms_read on run_arms for select to authenticated using (true);
-- Revive (Sources page): the operator may set an arm active again, nothing else.
grant update (status, revived_at) on search_arms to authenticated;
create policy search_arms_revive on search_arms for update to authenticated using (status = 'retired') with check (status = 'active');
