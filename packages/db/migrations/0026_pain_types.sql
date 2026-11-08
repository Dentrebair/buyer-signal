-- 0026: the pain types a signal shows (§10.1 filter), from its matched keyword categories; website
-- findings are "web". Filled at insert; earlier rows by `npm run backfill:pain-types`.
alter table challenges add column pain_types text[] not null default '{}';
create index idx_challenges_pain_types on challenges using gin (pain_types);
