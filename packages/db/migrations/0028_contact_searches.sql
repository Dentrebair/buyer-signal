-- 0028: contact search (operator's request, 2026-11-09; a separate screen to try out). The
-- operator's click inserts the request; the worker writes the plan, the matched contacts, the
-- model and the cost here. Contacts are LinkedIn names, headlines and profile links already
-- stored in li_posts / li_comments, so a search is purged with them (60 days).
create table contact_searches (
  id uuid primary key default gen_random_uuid(),
  query text not null check (char_length(query) between 8 and 400),
  status text not null default 'queued' check (status in ('queued', 'done', 'error')),
  error text,
  plan jsonb,
  results jsonb not null default '[]',
  candidates integer,
  model text,
  cost_usd numeric,
  requested_at timestamptz not null default now(),
  finished_at timestamptz
);
create index idx_contact_searches_requested on contact_searches (requested_at desc);

alter table contact_searches enable row level security;
revoke all on contact_searches from anon, authenticated;
grant select on contact_searches to authenticated;
grant insert (query) on contact_searches to authenticated;
create policy contact_searches_read on contact_searches for select to authenticated using (true);
create policy contact_searches_request on contact_searches for insert to authenticated with check (status = 'queued');
