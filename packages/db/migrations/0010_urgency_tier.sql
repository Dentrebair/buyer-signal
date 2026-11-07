-- 0010: urgency tier per signal (PRD §1.1), from fixed rules in @bs/core urgencyTier.
-- Existing rows are filled by `npm run tier:backfill` (free: keyword rules over stored evidence).
alter table challenges add column urgency_tier text check (urgency_tier in ('high', 'medium', 'low'));
create index idx_challenges_company_tier on challenges (company_id, urgency_tier);
