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
select pg_temp.try('authenticated', 'operator read drift_checks', 'allowed', 'select count(*) from drift_checks');
select pg_temp.try('anon', 'anon read drift_checks', 'blocked', 'select count(*) from drift_checks');
select pg_temp.try('authenticated', 'operator write drift_checks', 'blocked', 'delete from drift_checks');
select pg_temp.try('authenticated', 'operator read eval_runs', 'allowed', 'select count(*) from eval_runs');
select pg_temp.try('authenticated', 'operator write eval_runs', 'blocked', 'delete from eval_runs');
select pg_temp.try('anon', 'anon read eval_cases', 'blocked', 'select count(*) from eval_cases');
select pg_temp.try('authenticated', 'operator label eval_cases', 'allowed', 'insert into eval_cases (text, author_type, label) values (''rls test'', ''person'', ''none'')');
select pg_temp.try('authenticated', 'operator remove eval_cases', 'allowed', 'delete from eval_cases where text = ''rls test''');
-- Leak check (0022): the operator reads samples and proposals, and may only decide a proposal.
insert into trie_proposals (phrase, category) values ('rls test phrase', 'AUTOMATABLE_TASK');
select pg_temp.try('authenticated', 'operator read drop_samples', 'allowed', 'select count(*) from drop_samples');
select pg_temp.try('anon', 'anon read drop_samples', 'blocked', 'select count(*) from drop_samples');
select pg_temp.try('authenticated', 'operator write drop_samples', 'blocked', 'insert into drop_samples (natural_id, title, text) values (''rls'', ''x'', ''y'')');
select pg_temp.try('anon', 'anon read trie_proposals', 'blocked', 'select count(*) from trie_proposals');
select pg_temp.try('authenticated', 'operator add a proposal', 'blocked', 'insert into trie_proposals (phrase, category) values (''rls x'', ''AUTOMATABLE_TASK'')');
select pg_temp.try('authenticated', 'operator edit a phrase', 'blocked', 'update trie_proposals set phrase = ''edited'' where phrase = ''rls test phrase''');
select pg_temp.try('authenticated', 'operator approve a proposal', 'allowed', 'update trie_proposals set status = ''approved'' where phrase = ''rls test phrase''');
select pg_temp.try('authenticated', 'operator re-decide a decided one', 'blocked', 'do $$ begin update trie_proposals set status = ''rejected'' where phrase = ''rls test phrase''; if not found then raise exception ''no row''; end $$');
delete from trie_proposals where phrase = 'rls test phrase';
-- Drafts (0024): the operator may ask for drafts (insert a queued request) and read them; only
-- the worker records the result.
select pg_temp.try('authenticated', 'operator request drafts', 'allowed', 'insert into draft_requests (company_id) select id from companies where domain = ''rls-test.example''');
select pg_temp.try('authenticated', 'operator read draft requests', 'allowed', 'select count(*) from draft_requests');
select pg_temp.try('anon', 'anon read draft requests', 'blocked', 'select count(*) from draft_requests');
select pg_temp.try('authenticated', 'operator mark a request done', 'blocked', 'update draft_requests set status = ''done''');
select pg_temp.try('authenticated', 'operator write drafts on a company', 'blocked', 'update companies set outreach_drafts = ''{}'' where domain = ''rls-test.example''');
delete from draft_requests where company_id in (select id from companies where domain = 'rls-test.example');
-- Contact search (0028): the operator may ask (insert the query) and read; only the worker
-- writes the results. Rolled back with the rest.
select pg_temp.try('authenticated', 'operator request a contact search', 'allowed', 'insert into contact_searches (query) values (''rls check query'')');
select pg_temp.try('authenticated', 'operator read contact searches', 'allowed', 'select count(*) from contact_searches');
select pg_temp.try('anon', 'anon read contact searches', 'blocked', 'select count(*) from contact_searches');
select pg_temp.try('authenticated', 'operator write search results', 'blocked', 'update contact_searches set results = ''[]'', status = ''done''');
select pg_temp.try('authenticated', 'operator insert a finished search', 'blocked', 'insert into contact_searches (query, status) values (''rls check query'', ''done'')');
-- /roast (0029): the public page's role can ask for a roast and read one result, nothing else;
-- nobody else can call the functions. Rolled back with the rest.
select pg_temp.try('bs_roast', 'roast visitor request a roast', 'allowed', 'select * from request_roast(''rls-roast.example'', ''a@rls-roast.example'', true, ''roast:rls'', 5, 1000)');
select pg_temp.try('bs_roast', 'roast visitor read one result', 'allowed', 'select * from roast_result(gen_random_uuid())');
select pg_temp.try('bs_roast', 'roast visitor list requests', 'blocked', 'select count(*) from roast_requests');
select pg_temp.try('bs_roast', 'roast visitor read companies', 'blocked', 'select count(*) from companies');
select pg_temp.try('bs_roast', 'roast visitor write rate hits', 'blocked', 'delete from rate_hits');
select pg_temp.try('anon', 'anon request a roast', 'blocked', 'select * from request_roast(''rls-roast.example'', ''a@b.co'', false, ''roast:rls'', 5, 1000)');
select pg_temp.try('authenticated', 'operator request a roast directly', 'blocked', 'select * from request_roast(''rls-roast.example'', ''a@b.co'', false, ''roast:rls'', 5, 1000)');
select pg_temp.try('anon', 'anon read a roast result', 'blocked', 'select * from roast_result(gen_random_uuid())');
select pg_temp.try('authenticated', 'operator read roast requests', 'allowed', 'select count(*) from roast_requests');
select pg_temp.try('authenticated', 'operator change a roast', 'blocked', 'update roast_requests set status = ''done''');
-- Trends (0027): read only for the operator, nothing for anon.
select pg_temp.try('authenticated', 'operator read pain statements', 'allowed', 'select count(*) from pain_statements');
select pg_temp.try('anon', 'anon read pain statements', 'blocked', 'select count(*) from pain_statements');
select pg_temp.try('authenticated', 'operator write pain statements', 'blocked', 'insert into pain_statements (source, source_id, text, seen_at) values (''job_post'', ''x'', ''y'', now())');
select pg_temp.try('authenticated', 'operator read trends', 'allowed', 'select count(*) from trend_clusters');
select pg_temp.try('authenticated', 'operator write trends', 'blocked', 'delete from trend_clusters');
-- Alerts (0023): read only.
select pg_temp.try('authenticated', 'operator read alerts', 'allowed', 'select count(*) from alerts');
select pg_temp.try('anon', 'anon read alerts', 'blocked', 'select count(*) from alerts');
select pg_temp.try('authenticated', 'operator write alerts', 'blocked', 'insert into alerts (day, kind, message) values (''2000-01-01'', ''drift'', ''x'')');
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
