// Small text helpers shared by the prompts and the pages. Browser-safe (no dependencies).

// Data placed inside a prompt's XML-like tags, escaped so it cannot close a tag or open a new one.
export const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Links that are safe to render from scraped data: a URL check alone accepts javascript: and data:
// (zod's .url() does, 2026-11-09), so only these schemes pass.
export const httpsUrl = (u: string | null | undefined): string | null => (u && /^https:\/\/[^\s]+$/i.test(u.trim()) ? u.trim() : null);
export const webUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\/[^\s]+$/i.test(u.trim()) ? u.trim() : null);
