-- 0005: companies without a website (§5.1 step 5). A firm whose website can't be found is still
-- a lead: the card shows the hiring need and is marked "No website". It is keyed on
-- name_key = '<country>:<normalized name>:<city>' until a website turns up, then the domain is
-- attached to the same row.
alter table companies alter column domain drop not null;
alter table companies add column name_key text unique;
alter table companies add constraint companies_identity check (domain is not null or name_key is not null);
alter table ingestion_runs add column persisted_no_website_count integer not null default 0;
