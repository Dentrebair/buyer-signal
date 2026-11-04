-- 0003: start-board-run idempotency (§5.3a "safe to run twice").
-- The pg-boss job id is stored before the Apify run starts, so a retried job never starts a
-- second paid run. Status 'starting' = row written, Apify not yet confirmed.
alter table ingestion_runs add column job_key text unique;
