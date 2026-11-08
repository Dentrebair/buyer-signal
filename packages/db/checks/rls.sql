-- RLS / grant check (PRD §11). Runs in a transaction and rolls back; leaves no rows.
-- Usage: npm run db:check-rls   (expected outcomes are in the comments)
\set QUIET on
\pset tuples_only on
\pset format unaligned
begin;
insert into companies (domain, company_name) values ('rls-test.example', 'RLS Test');
create temp table results (check_name text, expected text, outcome text) on commit drop;
grant all on results to anon, authenticated;
create or replace function pg_temp.try(role_name text, label text, expected text, stmt text) returns void
language plpgsql as $$
declare got text;
begin
  execute format('set local role %I', role_name);
  begin execute stmt; got := 'allowed';
  exception when others then got := 'blocked';
  end;
  reset role;
  insert into results values (label, expected, got);
end $$;
select pg_temp.try('anon', 'anon select companies', 'blocked', 'select count(*) from companies');
select pg_temp.try('anon', 'anon select challenges', 'blocked', 'select count(*) from challenges');
select pg_temp.try('authenticated', 'operator select companies', 'allowed', 'select count(*) from companies');
select pg_temp.try('authenticated', 'operator update status', 'allowed', 'update companies set status = ''actioned'' where domain = ''rls-test.example''');
select pg_temp.try('authenticated', 'operator update priority_score', 'blocked', 'update companies set priority_score = 99 where domain = ''rls-test.example''');
select pg_temp.try('authenticated', 'operator insert company', 'blocked', 'insert into companies (domain) values (''x.example'')');
select pg_temp.try('authenticated', 'operator delete company', 'blocked', 'delete from companies');
select pg_temp.try('authenticated', 'operator read seen_items', 'blocked', 'select count(*) from seen_items');
select pg_temp.try('authenticated', 'operator read spend_counters', 'allowed', 'select count(*) from spend_counters');
select pg_temp.try('authenticated', 'operator read resolve_queue', 'blocked', 'select count(*) from resolve_queue');
select pg_temp.try('authenticated', 'operator read rotation_days', 'allowed', 'select count(*) from rotation_days');
select pg_temp.try('anon', 'anon read rotation_days', 'blocked', 'select count(*) from rotation_days');
select pg_temp.try('authenticated', 'operator write rotation_days', 'blocked', 'insert into rotation_days (day, slots) values (''2000-01-01'', ''[]'')');
select pg_temp.try('anon', 'anon read resolve_queue', 'blocked', 'select count(*) from resolve_queue');
select pg_temp.try('authenticated', 'operator read social_results', 'allowed', 'select count(*) from social_results');
select pg_temp.try('anon', 'anon read social_results', 'blocked', 'select count(*) from social_results');
select pg_temp.try('authenticated', 'operator write social_results', 'blocked', 'delete from social_results');
select pg_temp.try('authenticated', 'operator read search_arms', 'allowed', 'select count(*) from search_arms');
select pg_temp.try('anon', 'anon read search_arms', 'blocked', 'select count(*) from search_arms');
select pg_temp.try('authenticated', 'operator insert search_arms', 'blocked', 'insert into search_arms (kind, country, term, grp) values (''job'', ''us'', ''x'', ''low'')');
select pg_temp.try('authenticated', 'operator rename an arm', 'blocked', 'update search_arms set term = ''x''');
select pg_temp.try('authenticated', 'operator read run_arms', 'allowed', 'select count(*) from run_arms');
select pg_temp.try('authenticated', 'operator write run_arms', 'blocked', 'delete from run_arms');
select pg_temp.try('authenticated', 'operator read li_posts', 'allowed', 'select count(*) from li_posts');
select pg_temp.try('anon', 'anon read li_posts', 'blocked', 'select count(*) from li_posts');
select pg_temp.try('authenticated', 'operator write li_posts', 'blocked', 'update li_posts set has_pain = true');
select pg_temp.try('authenticated', 'operator read li_comments', 'allowed', 'select count(*) from li_comments');
select pg_temp.try('anon', 'anon read li_comments', 'blocked', 'select count(*) from li_comments');
select pg_temp.try('authenticated', 'operator write li_comments', 'blocked', 'delete from li_comments');
-- Status trigger (migration 0002): the inbox's Reject / Undo path, run as the operator.
update companies set priority_score = 77, status = 'new', score_breakdown = '{"families":["job_post"]}' where domain = 'rls-test.example';
select pg_temp.try('authenticated', 'operator lock row for action', 'allowed', 'select 1 from companies where domain = ''rls-test.example'' for update');
select pg_temp.try('authenticated', 'operator reject without reason', 'blocked', 'update companies set status = ''rejected'' where domain = ''rls-test.example''');
select pg_temp.try('authenticated', 'operator reject with reason', 'allowed', 'update companies set status = ''rejected'', rejection_reason = ''too_small'' where domain = ''rls-test.example''');
insert into results select 'reject stores score + families', 'allowed',
  case when rejected_score = 77 and rejected_families = '["job_post"]' then 'allowed' else 'blocked' end
  from companies where domain = 'rls-test.example';
select pg_temp.try('authenticated', 'operator undo to new', 'allowed', 'update companies set status = ''new'', rejection_reason = null where domain = ''rls-test.example''');
insert into results select 'undo clears rejection fields', 'allowed',
  case when rejected_score is null and rejection_reason is null and rejected_families = '[]' then 'allowed' else 'blocked' end
  from companies where domain = 'rls-test.example';
select pg_temp.try('authenticated', 'operator mark sent', 'allowed', 'update companies set status = ''actioned'' where domain = ''rls-test.example''');
insert into results select 'sent sets actioned_at', 'allowed',
  case when actioned_at is not null then 'allowed' else 'blocked' end from companies where domain = 'rls-test.example';
select case when outcome = expected then 'PASS ' else 'FAIL ' end || check_name || ' (' || outcome || ')' from results;
select case when count(*) = 0 then 'ALL PASS' else count(*) || ' FAILED' end from results where outcome <> expected;
rollback;
