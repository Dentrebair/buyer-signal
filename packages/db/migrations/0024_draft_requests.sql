-- 0024: email drafts on demand (PRD §9). The operator's click inserts a request; the worker writes
-- the three emails to companies.outreach_drafts and records the model, cost or error here. At
-- most one request writing per company, so a double click costs nothing.
create table draft_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'done', 'error')),
  error text,
  model text,
  cost_usd numeric,
  requested_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index uq_draft_requests_queued on draft_requests (company_id) where status = 'queued';
create index idx_draft_requests_company on draft_requests (company_id, requested_at desc);

alter table draft_requests enable row level security;
revoke all on draft_requests from anon, authenticated;
grant select on draft_requests to authenticated;
grant insert (company_id) on draft_requests to authenticated;
create policy draft_requests_read on draft_requests for select to authenticated using (true);
create policy draft_requests_request on draft_requests for insert to authenticated with check (status = 'queued');
