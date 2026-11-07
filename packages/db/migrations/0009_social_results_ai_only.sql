-- 0009: social_results keeps only posts the AI reads (leads, posts in progress, and the AI's drops
-- for 7 days). Free drops — not a post, too old, repeats, recruiter wording — are only counted
-- on ingestion_runs; seen_items already stops a repeat.
delete from social_results where outcome in ('not_post', 'stale', 'seen', 'recruiter');
alter table social_results drop constraint social_results_outcome_check;
alter table social_results add constraint social_results_outcome_check
  check (outcome in ('checking', 'stance', 'no_company', 'no_fit', 'too_large', 'card'));
