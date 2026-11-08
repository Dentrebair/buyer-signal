-- 0027: anonymous pain trends (§5.6, built 2026-11-08). Short pain statements without names, from
-- job posts' manual work, LinkedIn posts' pains and commenters' critical points, with their
-- embeddings; and the groups the weekly trends job builds from them (replaced on every run).
create table pain_statements (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('job_post', 'li_post', 'li_comment')),
  source_id text not null,
  part integer not null default 0, -- a LinkedIn post can name up to 3 pains
  vertical text,
  country text,
  text text not null,
  embedding vector(768),
  seen_at timestamptz not null, -- when the pain was posted (else read)
  created_at timestamptz not null default now(),
  unique (source, source_id, part)
);
create index idx_pain_statements_vertical on pain_statements (vertical, seen_at);

create table trend_clusters (
  id uuid primary key default gen_random_uuid(),
  vertical text,
  label text, -- null for a group under the naming size
  summary text,
  size integer not null,
  recent integer not null, -- the last 30 days
  previous integer not null, -- the 30 days before
  sources jsonb not null default '{}',
  examples text[] not null default '{}',
  member_ids uuid[] not null default '{}',
  built_at timestamptz not null default now()
);
create index idx_trend_clusters_vertical on trend_clusters (vertical, size desc);

alter table pain_statements enable row level security;
alter table trend_clusters enable row level security;
revoke all on pain_statements, trend_clusters from anon, authenticated;
grant select on pain_statements, trend_clusters to authenticated;
create policy pain_statements_read on pain_statements for select to authenticated using (true);
create policy trend_clusters_read on trend_clusters for select to authenticated using (true);
