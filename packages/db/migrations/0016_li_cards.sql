-- 0016: LinkedIn post search replaces the Google digest (PRD §4.1d, 2026-11-08).
-- A pain post by the business's own people becomes an inbox card; card_outcome says whether it
-- did and why not. author_country is the AI's read of where the author's business is.
alter table li_posts
  add column author_country text check (author_country in ('in', 'ae', 'us', 'other', 'unknown')),
  add column card_outcome text check (card_outcome in
    ('checking', 'card', 'no_pain', 'not_own', 'no_company', 'no_market', 'duplicate', 'no_fit', 'too_large', 'ai_error'));

-- The rotation's topic arms are now one per vertical (country 'all': LinkedIn search has no
-- market filter). The Google digest's per-market topic arms retire with their history kept.
update search_arms set status = 'retired', retired_at = now()
 where kind = 'social' and country <> 'all' and status = 'active';
