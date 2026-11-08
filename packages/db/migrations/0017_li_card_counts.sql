-- 0017: a LinkedIn post search run's llm_persisted_count counted its pain posts until 2026-11-08;
-- it now counts cards, which the bandit credits (§4.1c). Earlier runs get their real card count.
update ingestion_runs r set llm_persisted_count = (select count(*) from challenges ch where ch.run_id = r.id)
 where r.job_type = 'li_posts';
