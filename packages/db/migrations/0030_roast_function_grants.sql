-- 0030: Supabase's default privileges also grant execute on new functions to anon and
-- authenticated directly (not through PUBLIC), so 0029's revoke left the roast functions callable
-- by anyone with the anon key. Only bs_roast (the /roast page) may call them. Caught by
-- checks/rls.sql, 2026-11-09.
revoke all on function request_roast(text, text, boolean, text, int, int) from anon, authenticated;
revoke all on function roast_result(uuid) from anon, authenticated;
