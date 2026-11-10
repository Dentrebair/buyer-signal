-- 0029: /roast, "Roast My Stack" (PRD §8, built 2026-11-09). A visitor's request (site + work
-- email), the teardown the worker writes, and the company it became. The public page runs as
-- bs_roast, a role that can do exactly two things: ask for a roast (rate limit and daily cap
-- checked inside, under one lock) and read one result by its id, without the email. It reads no
-- table directly, so no visitor can list other visitors. The operator may read the requests.
create table roast_requests (
  id uuid primary key default gen_random_uuid(),
  domain text not null check (char_length(domain) between 4 and 253),
  email text not null check (char_length(email) between 6 and 254),
  email_verified boolean not null,
  status text not null default 'queued' check (status in ('queued', 'done', 'error')),
  error text,
  teardown jsonb,
  company_id uuid references companies (id) on delete set null,
  model text,
  cost_usd numeric,
  requested_at timestamptz not null default now(),
  finished_at timestamptz
);
create index idx_roast_requests_requested on roast_requests (requested_at desc);
create index idx_roast_requests_domain on roast_requests (domain, requested_at desc);

alter table roast_requests enable row level security;
revoke all on roast_requests from anon, authenticated;
grant select on roast_requests to authenticated;
create policy roast_requests_read on roast_requests for select to authenticated using (true);

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'bs_roast') then create role bs_roast nologin; end if;
end $$;
grant bs_roast to current_user;

-- Returns the request id, or why it was refused: 'rate' (this visitor, 5 an hour) or 'cap' (all
-- visitors, per UTC day). The same site asked for again while its roast runs gets that roast.
create function request_roast(p_domain text, p_email text, p_verified boolean, p_bucket text, p_per_hour int, p_daily_cap int)
returns table (id uuid, refused text) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('roast_requests'));
  select r.id into v_id from roast_requests r where r.domain = p_domain and r.status = 'queued' and r.requested_at > now() - interval '10 minutes' limit 1;
  if v_id is not null then return query select v_id, null::text; return; end if;
  if (select count(*) from rate_hits h where h.bucket = p_bucket and h.hit_at > now() - interval '1 hour') >= p_per_hour then
    return query select null::uuid, 'rate'::text; return;
  end if;
  if (select count(*) from roast_requests r where r.requested_at >= date_trunc('day', now(), 'UTC')) >= p_daily_cap then
    return query select null::uuid, 'cap'::text; return;
  end if;
  insert into rate_hits (bucket) values (p_bucket);
  insert into roast_requests (domain, email, email_verified) values (p_domain, p_email, p_verified) returning roast_requests.id into v_id;
  return query select v_id, null::text;
end $$;

-- One result for the visitor who holds its id. Never the email.
create function roast_result(p_id uuid)
returns table (status text, domain text, teardown jsonb, error text, requested_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.status, r.domain, r.teardown, r.error, r.requested_at from roast_requests r where r.id = p_id
$$;

revoke all on function request_roast(text, text, boolean, text, int, int) from public;
revoke all on function roast_result(uuid) from public;
grant execute on function request_roast(text, text, boolean, text, int, int) to bs_roast;
grant execute on function roast_result(uuid) to bs_roast;
