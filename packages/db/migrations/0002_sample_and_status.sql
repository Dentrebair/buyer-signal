-- 0002: sample-data flag (Sprint 1 seed) and status bookkeeping the operator cannot write.

-- Sprint 0 posts are older than 21 days and undated (§4.3), so they are test data, never leads.
-- `npm run db:unseed` deletes every sample company (challenges cascade).
alter table companies add column is_sample boolean not null default false;

-- The operator may only update status, rejection_reason and actioned_at (§11 RLS). The
-- resurfacing fields (§10.3) are set here instead, so they always match the status change.
create or replace function companies_status_bookkeeping() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'rejected' then
      new.rejected_score := old.priority_score;
      new.rejected_families := coalesce(old.score_breakdown -> 'families', '[]'::jsonb);
      new.actioned_at := null;
    elsif new.status = 'actioned' then
      new.actioned_at := coalesce(new.actioned_at, now());
      new.rejection_reason := null;
    else -- back to 'new' (undo)
      new.rejection_reason := null;
      new.rejected_score := null;
      new.rejected_families := '[]'::jsonb;
      new.actioned_at := null;
    end if;
  end if;
  if new.status = 'rejected' and new.rejection_reason is null then
    raise exception 'rejection_reason is required when rejecting';
  end if;
  return new;
end $$;

create trigger trg_companies_status before update of status on companies
  for each row execute function companies_status_bookkeeping();
