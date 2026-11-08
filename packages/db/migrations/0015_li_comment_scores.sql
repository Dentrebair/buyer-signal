-- 0015: a commenter's pain, scored (PRD §4.1d, 2026-11-08). The AI labels urgency and depth
-- signals; commentPainScore turns them into urgency %, depth % and a 0-100 score.
alter table li_comments
  add column urgency text check (urgency in ('none', 'nuisance', 'recurring', 'blocking')),
  add column signals text[] not null default '{}',
  add column urgency_pct integer,
  add column depth_pct integer,
  add column pain_score integer;
