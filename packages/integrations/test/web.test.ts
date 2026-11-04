import { describe, expect, it } from "vitest";
import { fetchPage, isPublicAddress, pageText } from "../src/index.ts";

describe("company website fetch", () => {
  it("refuses private, loopback, link-local and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "104.16.1.1", "2606:4700::1111"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("never connects to localhost, even by name", async () => {
    expect(await fetchPage("http://localhost:3000/")).toBeNull();
    expect(await fetchPage("http://127.0.0.1:3000/")).toBeNull();
    expect(await fetchPage("file:///etc/passwd")).toBeNull();
  });

  it("extracts visible text", () => {
    expect(pageText("<title>Acme &amp; Sons</title><script>var x='Hidden'</script><p>Dubai</p>").trim()).toBe("Acme & Sons Dubai");
  });
});
