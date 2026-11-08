// Raw payload archive (Q64, §18.9): what each run fetched, personal fields stripped, kept 21 days
// so the pipeline can be re-run after a keyword or prompt change without paying Apify again.
// Pure: what is kept. The store sits behind RawArchive (Q66); Supabase Storage in integrations.

export const RAW_KEEP_DAYS = 21;
export type RawSource = "indeed" | "li_posts";

export interface RawArchive {
  // raw/{source}/{YYYY-MM-DD}/{runId}-{part}.json.gz
  put(x: { source: RawSource; day: string; runId: string; part: string; items: unknown[] }): Promise<void>;
  // Deletes every day folder older than `keepDays`; returns the files removed.
  purge(keepDays: number, now: Date): Promise<number>;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /\+?\d[\d ().-]{7,}\d/g;
// Emails and phone numbers masked: also used for leak-check samples (leakCheck.ts).
export const maskContacts = (s: string) => s.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
const scrub = maskContacts;
// Keys never archived, wherever they sit (§6.5: no named individuals' contacts).
const PERSONAL_KEY = /^(ceoName|streetAddress|email|emails|phone|phones|phoneNumber|recruiter|recruiterName|contact|contacts|avatar|picture|profilePicture)$/i;

function strip(v: unknown): unknown {
  if (typeof v === "string") return scrub(v);
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).filter(([k]) => !PERSONAL_KEY.test(k)).map(([k, x]) => [k, strip(x)]));
  return v;
}

// LinkedIn: the person behind a post or comment is reduced to whether it is a person or a page
// (and, for a comment, whether it is the post's author). Text, dates and counts stay.
function stripLinkedin(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const { author, actor, reactions, comments, ...rest } = item as Record<string, unknown>;
  const who = (x: unknown) => (x && typeof x === "object" ? { type: (x as { type?: unknown }).type ?? null, author: (x as { author?: unknown }).author } : null);
  return {
    ...(strip(rest) as object),
    ...(author !== undefined ? { author: who(author) } : {}),
    ...(actor !== undefined ? { actor: who(actor) } : {}),
    ...(comments !== undefined ? { comments: [] } : {}), // comments arrive as their own items
    ...(reactions !== undefined ? { reactions: [] } : {}),
  };
}

export function stripPersonal(source: RawSource, items: unknown[]): unknown[] {
  return source === "li_posts" ? items.map(stripLinkedin) : items.map(strip);
}

export const rawPath = (x: { source: RawSource; day: string; runId: string; part: string }) => `${x.source}/${x.day}/${x.runId}-${x.part}.json.gz`;
