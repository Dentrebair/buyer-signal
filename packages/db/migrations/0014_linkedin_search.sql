-- 0014: LinkedIn post search (PRD §4.1d). Posts searched on LinkedIn with their comments, and
-- what the AI read in them. Authors and commenters: name, headline and profile link only (no
-- profile visits, no email lookups; an email only when they typed it). Personal data, so kept
-- 60 days (poll-runs purges). The operator may read; only the worker writes.
create table li_posts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ingestion_runs(id) on delete cascade,
  post_id text not null,
  url text not null,
  posted_at timestamptz,
  body text not null default '',
  author_type text not null check (author_type in ('person', 'company')),
  author_name text,
  author_headline text,
  author_url text,
  author_website text,
  likes integer not null default 0,
  comment_count integer not null default 0,
  shares integer not null default 0,
  status text not null default 'reading' check (status in ('reading', 'read', 'ai_error')),
  has_pain boolean,
  pains jsonb not null default '[]',
  stance text,
  author_relation text,
  author_company text,
  emails text[] not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, post_id)
);
create index idx_li_posts_run on li_posts (run_id);

create table li_comments (
  id uuid primary key default gen_random_uuid(),
  li_post_id uuid not null references li_posts(id) on delete cascade,
  comment_id text not null,
  url text,
  body text not null default '',
  commented_at timestamptz,
  actor_type text not null check (actor_type in ('person', 'company')),
  name text,
  headline text,
  profile_url text,
  is_author boolean not null default false,
  likes integer not null default 0,
  resonates boolean,
  gist text,
  company text,
  emails text[] not null default '{}',
  unique (li_post_id, comment_id)
);
create index idx_li_comments_post on li_comments (li_post_id);

alter table li_posts enable row level security;
alter table li_comments enable row level security;
revoke all on li_posts, li_comments from anon, authenticated;
grant select on li_posts, li_comments to authenticated;
create policy li_posts_read on li_posts for select to authenticated using (true);
create policy li_comments_read on li_comments for select to authenticated using (true);
