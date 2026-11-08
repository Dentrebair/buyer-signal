-- 0021: a commenter's own card (operator's choice, 2026-11-08: green or yellow comments). The AI
-- read now says whose company the commenter speaks for and where it is; card_outcome records the
-- card gate's verdict, as on li_posts.
alter table li_comments
  add column relation text check (relation in ('founder_owner', 'employee', 'company_page', 'former_employee', 'vendor', 'commentator', 'recruiter')),
  add column country text check (country in ('in', 'ae', 'us', 'other', 'unknown')),
  add column card_outcome text check (card_outcome in
    ('checking', 'card', 'no_pain', 'not_own', 'no_company', 'no_market', 'duplicate', 'no_fit', 'too_large', 'ai_error'));
