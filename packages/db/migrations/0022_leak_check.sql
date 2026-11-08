-- 0022: leak check (audit-dropped, §6.3 step 6). A fixed 2 % of the job posts the keyword trie
-- drops are kept 21 days; the AI reads them daily, and phrases from real leads are proposed to
-- the operator. Approved phrases join the trie.
create table drop_samples (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references ingestion_runs (id) on delete set null,
  natural_id text not null unique,
  vertical text,
  country text,
  title text not null,
  text text not null, -- emails and phone numbers masked
  status text not null default 'pending' check (status in ('pending', 'checked', 'ai_error')),
  is_lead boolean,
  reason text,
  phrases jsonb not null default '[]',
  checked_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_drop_samples_pending on drop_samples (status, created_at);

create table trie_proposals (
  id uuid primary key default gen_random_uuid(),
  phrase text not null,
  category text not null check (category in ('AUTOMATABLE_TASK', 'MANUAL_ROLE', 'INTEGRATION_DEBT', 'DOCUMENT_FRICTION', 'INFORMATION_SILO')),
  vertical text, -- the vertical of the posts it came from
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  evidence integer not null default 1, -- dropped posts that were leads and contain it
  evidence_at_decision integer, -- a rejected phrase comes back once evidence doubles (§4.1c)
  examples uuid[] not null default '{}', -- drop_samples ids
  reason text, -- the operator's, on reject
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index uq_trie_proposals on trie_proposals (lower(phrase), coalesce(vertical, ''));

-- The operator reads both, and may only decide a proposal: proposed → approved or rejected.
alter table drop_samples enable row level security;
alter table trie_proposals enable row level security;
revoke all on drop_samples, trie_proposals from anon, authenticated;
grant select on drop_samples, trie_proposals to authenticated;
grant update (status, reason, decided_at) on trie_proposals to authenticated;
create policy drop_samples_read on drop_samples for select to authenticated using (true);
create policy trie_proposals_read on trie_proposals for select to authenticated using (true);
create policy trie_proposals_decide on trie_proposals for update to authenticated
  using (status = 'proposed') with check (status in ('approved', 'rejected'));

-- The evidence a decision was made on, recorded by the database, not the client.
create function trie_proposal_decided() returns trigger language plpgsql as $$
begin
  if new.status <> old.status then
    new.evidence_at_decision := old.evidence;
    new.decided_at := now();
  end if;
  return new;
end $$;
create trigger trg_trie_proposal_decided before update on trie_proposals for each row execute function trie_proposal_decided();
