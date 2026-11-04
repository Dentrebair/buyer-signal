// Company-name normalisation for the domain cache key (§5.1 step 5).
const SUFFIXES =
  /\b(private limited|pvt\.? ?ltd\.?|pvt|ltd\.?|limited|llc|l\.l\.c\.?|fzco|fze|fz-llc|inc\.?|incorporated|corp\.?|corporation|co\.?|company|llp|plc|gmbh)\b/g;

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/&/g, " and ")
    .replace(SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function domainCacheKey(name: string, place: string | null): string {
  return `${normalizeCompanyName(name)}:${(place ?? "").toLowerCase().trim()}`;
}

// Bare domain from a URL or host: "https://www.Acme.com/about" → "acme.com".
export function bareDomain(input: string | null | undefined): string | null {
  const m = (input ?? "").trim().toLowerCase().match(/^(?:[a-z]+:\/\/)?(?:www\.)?([^/:?#\s]+)/);
  return m?.[1] && m[1].includes(".") ? m[1] : null;
}
