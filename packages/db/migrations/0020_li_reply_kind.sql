-- 0020: what a comment does for the post's problem (operator's colours, 2026-11-08): shares
-- (green), perspective (yellow), unhelpful (red). Null on comments read before it existed.
alter table li_comments add column reply_kind text check (reply_kind in ('shares', 'perspective', 'unhelpful'));
