-- Company-check agent (PRD §5.1a): what it found about a company (website, size band with
-- evidence, vertical and place match, one-line summary, steps and cost). Shown on the card.
alter table companies add column company_check jsonb;
