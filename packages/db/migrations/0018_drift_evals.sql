-- 0018: drift check and AI test set (agreed 2026-11-08).
-- drift_checks: each day's comparison of the last 7 days with the 14 before (core drift.ts).
create table drift_checks (
  day date not null,
  metric text not null,
  window_num numeric not null,
  window_den numeric not null,
  base_num numeric not null,
  base_den numeric not null,
  verdict text not null check (verdict in ('ok', 'moved', 'too_few')),
  direction text check (direction in ('up', 'down')),
  worse boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (day, metric)
);

-- eval_cases: LinkedIn posts the operator labelled. Copied without the author's name, profile
-- link or emails (core anonymise), so they outlive the 60-day purge of li_posts (§4.1d).
create table eval_cases (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'li_post' check (kind in ('li_post')),
  li_post_id uuid unique references li_posts (id) on delete set null,
  text text not null,
  headline text,
  author_type text not null check (author_type in ('person', 'company')),
  label text not null check (label in ('lead', 'pain', 'none')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- eval_runs: one npm run eval, with the model and prompt it scored.
create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('li_post')),
  model text not null,
  prompt_hash text not null,
  cases integer not null,
  score jsonb not null,
  cost_usd numeric not null default 0,
  created_at timestamptz not null default now()
);

alter table drift_checks enable row level security;
alter table eval_cases enable row level security;
alter table eval_runs enable row level security;
grant select on drift_checks, eval_runs to authenticated;
create policy drift_checks_read on drift_checks for select to authenticated using (true);
create policy eval_runs_read on eval_runs for select to authenticated using (true);
-- Labelling is the operator's own work: they may add, change and remove cases.
grant select, insert, update, delete on eval_cases to authenticated;
create policy eval_cases_all on eval_cases for all to authenticated using (true) with check (true);
