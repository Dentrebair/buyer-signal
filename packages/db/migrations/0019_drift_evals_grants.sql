-- 0019: 0018 left Supabase's default grants in place (anon could read, the operator could
-- write drift results and eval runs). Revoke all, then grant only what 0018 meant.
revoke all on drift_checks, eval_cases, eval_runs from anon, authenticated;
grant select on drift_checks, eval_runs to authenticated;
grant select, insert, update, delete on eval_cases to authenticated;
