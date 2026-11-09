// /contacts: the operator's searches and the chosen one's matched people.
import type { ContactMatch, MatchPlan } from "@bs/core";
import { asOperator } from "./operator.ts";

export interface SearchSummary {
  id: string;
  query: string;
  status: "queued" | "done" | "error";
  found: number;
  requested_at: string;
}

export interface SearchDetail extends SearchSummary {
  error: string | null;
  plan: MatchPlan | null;
  results: ContactMatch[];
  candidates: number | null;
  model: string | null;
  cost_usd: number | null;
}

export function loadContacts(id: string | null): Promise<{ searches: SearchSummary[]; current: SearchDetail | null }> {
  return asOperator(async (c) => {
    const searches = (
      await c.query<SearchSummary>(
        `select id, query, status, jsonb_array_length(results) found, requested_at::text from contact_searches order by requested_at desc limit 20`,
      )
    ).rows;
    const current = id
      ? ((
          await c.query<SearchDetail>(
            `select id, query, status, jsonb_array_length(results) found, requested_at::text, error, plan, results, candidates, model, cost_usd::float8 cost_usd
               from contact_searches where id = $1`,
            [id],
          )
        ).rows[0] ?? null)
      : null;
    return { searches, current };
  });
}
