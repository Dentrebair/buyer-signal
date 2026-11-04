import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProviderError, RdapClient } from "../src/index.ts";

// Real Verisign response for auditvista.com (2026-11-04), trimmed to the fields we read.
const auditvista = readFileSync(new URL("./fixtures/rdap-verisign-auditvista.json", import.meta.url), "utf8");
const bootstrap = JSON.stringify({
  services: [
    [["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
    [["in"], ["http://rdap.example/in/", "https://rdap.nixiregistry.in/rdap/"]],
  ],
});

function fake(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return r();
  }) as typeof fetch;
  return { client: new RdapClient(fetchFn), calls };
}
const json = (body: string, status = 200) => () => new Response(body, { status });
const BOOT = "https://data.iana.org/rdap/dns.json";

describe("RDAP domain age (§6.7 step 2)", () => {
  it("reads the registration event from the registry named in the IANA bootstrap", async () => {
    const { client, calls } = fake({ [BOOT]: json(bootstrap), "https://rdap.verisign.com/com/v1/domain/auditvista.com": json(auditvista) });
    expect((await client.registeredAt("AuditVista.com"))?.toISOString()).toBe("2021-07-11T06:23:41.000Z");
    expect(calls).toEqual([BOOT, "https://rdap.verisign.com/com/v1/domain/auditvista.com"]);
  });

  it("caches the bootstrap and only uses https registry servers", async () => {
    const { client, calls } = fake({
      [BOOT]: json(bootstrap),
      "https://rdap.nixiregistry.in/rdap/domain/jumoo.in": json('{"events":[{"eventAction":"registration","eventDate":"2020-02-04T00:00:00Z"}]}'),
      "https://rdap.nixiregistry.in/rdap/domain/acme.co.in": json('{"events":[]}'),
    });
    expect(await client.registeredAt("jumoo.in")).toEqual(new Date("2020-02-04T00:00:00Z"));
    expect(await client.registeredAt("acme.co.in")).toBeNull(); // no registration event
    expect(calls.filter((c) => c === BOOT)).toHaveLength(1);
  });

  it("unknown, not an error: no RDAP server (.ae), no record, or a malformed domain", async () => {
    const { client, calls } = fake({ [BOOT]: json(bootstrap), "https://rdap.verisign.com/com/v1/domain/gone.com": json("{}", 404) });
    expect(await client.registeredAt("oriongroup.ae")).toBeNull();
    expect(await client.registeredAt("gone.com")).toBeNull();
    expect(await client.registeredAt("x.com/../../admin")).toBeNull();
    expect(calls).toEqual([BOOT, "https://rdap.verisign.com/com/v1/domain/gone.com"]);
  });

  it("throws on rate limits and server errors, so the caller can log and move on", async () => {
    const { client } = fake({ [BOOT]: json(bootstrap), "https://rdap.verisign.com/com/v1/domain/busy.com": json("slow down", 429) });
    await expect(client.registeredAt("busy.com")).rejects.toBeInstanceOf(ProviderError);
  });
});
