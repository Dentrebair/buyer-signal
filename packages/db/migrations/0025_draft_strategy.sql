-- 0025: one email per click (operator's choice, 2026-11-08). A request names the approach to write;
-- null = the recommended one. The operator may set it when asking.
alter table draft_requests add column strategy text check (strategy in ('direct_active_intent', 'peer_benchmark_question', 'educational_value_first'));
grant insert (strategy) on draft_requests to authenticated;
