// Supabase Storage for the raw payload archive (Q64). Verified 2026-11-08: private bucket `raw`,
// upload with x-upsert, list by prefix (folders come back with a null id), delete by prefixes;
// the anon key cannot read an object. The service role key goes in a header, never a URL.
import { gzipSync } from "node:zlib";
import { type RawArchive, rawPath, stripPersonal } from "@bs/core";

const BUCKET = "raw";
const DAY = 86_400_000;

export class SupabaseRawArchive implements RawArchive {
  private base: string;
  private headers: Record<string, string>;
  constructor(url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY) {
    if (!url || !key) throw new Error("SupabaseRawArchive needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    this.base = `${url}/storage/v1`;
    this.headers = { Authorization: `Bearer ${key}`, apikey: key };
  }

  async put(x: Parameters<RawArchive["put"]>[0]): Promise<void> {
    const body = gzipSync(Buffer.from(JSON.stringify(stripPersonal(x.source, x.items))));
    const r = await fetch(`${this.base}/object/${BUCKET}/${rawPath(x)}`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/gzip", "x-upsert": "true" }, // a retried fetch replaces its own file
      body,
    });
    if (!r.ok) throw new Error(`raw archive upload ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }

  private async list(prefix: string): Promise<{ name: string; id: string | null }[]> {
    const r = await fetch(`${this.base}/object/list/${BUCKET}`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000 }),
    });
    if (!r.ok) throw new Error(`raw archive list ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as { name: string; id: string | null }[];
  }

  async purge(keepDays: number, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - keepDays * DAY).toISOString().slice(0, 10);
    let removed = 0;
    for (const source of ["indeed", "li_posts"]) {
      for (const day of await this.list(`${source}/`)) {
        if (day.id !== null || !/^\d{4}-\d{2}-\d{2}$/.test(day.name) || day.name >= cutoff) continue; // folders only, old ones only
        const files = (await this.list(`${source}/${day.name}/`)).filter((f) => f.id !== null).map((f) => `${source}/${day.name}/${f.name}`);
        if (!files.length) continue;
        const r = await fetch(`${this.base}/object/${BUCKET}`, {
          method: "DELETE",
          headers: { ...this.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes: files }),
        });
        if (!r.ok) throw new Error(`raw archive delete ${r.status}: ${(await r.text()).slice(0, 200)}`);
        removed += files.length;
      }
    }
    return removed;
  }
}
