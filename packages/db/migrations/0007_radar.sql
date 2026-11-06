-- 0007: /radar Sources page. resolve_queue stays service-only (it holds employer names and
-- raw post payloads); the operator may see two counts from it, nothing else.
create function radar_resolve_stats() returns table (pending integer, searched_today integer)
language sql stable security definer set search_path = public as $$
  select count(*) filter (where status = 'pending')::int,
         count(*) filter (where searched_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')::int
    from resolve_queue
$$;
revoke all on function radar_resolve_stats() from public, anon;
grant execute on function radar_resolve_stats() to authenticated;
