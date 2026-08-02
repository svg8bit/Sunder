import { describe, expect, it, vi } from "vitest";
import { proxyRecentTokens } from "../api/market/recent";

describe("Vercel market-data cache boundary", () => {
  it("caches bounded successful Jupiter payloads at the CDN", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([{ id: "x".repeat(32) }]), { status: 200 })) as unknown as typeof fetch;
    const response = await proxyRecentTokens(new Request("https://sunder.test/api/market/recent"), fetcher);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=5");
    expect(response.headers.get("x-sunder-market-source")).toBe("jupiter-tokens-v2");
    expect(fetcher).toHaveBeenCalledWith("https://lite-api.jup.ag/tokens/v2/recent", expect.objectContaining({ method: "GET", cache: "no-store" }));
  });

  it("does not expose upstream errors and rejects write methods", async () => {
    const unavailable = vi.fn(async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const failed = await proxyRecentTokens(new Request("https://sunder.test/api/market/recent"), unavailable);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("rate limited");
    const write = await proxyRecentTokens(new Request("https://sunder.test/api/market/recent", { method: "POST" }), unavailable);
    expect(write.status).toBe(405);
    expect(write.headers.get("allow")).toBe("GET");
  });
});
