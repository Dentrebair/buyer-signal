-- 0013: a post the AI could not read (invalid output after its retry, or still "checking" an hour
-- on) is marked ai_error instead of staying "checking" for ever, which kept the Sources page
-- refreshing itself. Kept 7 days with the AI's other drops.
alter table social_results drop constraint social_results_outcome_check;
alter table social_results add constraint social_results_outcome_check
  check (outcome in ('checking', 'stance', 'no_company', 'no_fit', 'too_large', 'card', 'ai_error'));
update social_results set outcome = 'ai_error' where outcome = 'checking' and created_at < now() - interval '1 hour';
