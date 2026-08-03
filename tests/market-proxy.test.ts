import { describe, expect, it, vi } from "vitest";
import { proxyRecentTokens } from "../api/market/recent";
import { servePumpTradeHistory } from "../api/market/pump-history";

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

  it("serves JSON-safe confirmed Pump history for a mint page refresh", async () => {
    const signature = "z".repeat(88);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { readonly method: string };
      if (body.method === "getSignaturesForAddress") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ signature, slot: 10, err: null }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { slot: 10, meta: { logMessages: [] } } }), { status: 200 });
    });
    const response = await servePumpTradeHistory(
      new Request("https://sunder.test/api/market/pump-history?mint=So11111111111111111111111111111111111111112&decimals=9"),
      fetcher as unknown as typeof fetch,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sunder-market-source")).toBe("pump-confirmed-rpc");
    expect(await response.json()).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed Pump history requests before reaching RPC", async () => {
    const response = await servePumpTradeHistory(new Request("https://sunder.test/api/market/pump-history?mint=nope&decimals=99"));
    expect(response.status).toBe(400);
  });

  it("falls back when a free RPC returns incomplete transaction history", async () => {
    const signature = "f".repeat(88);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { readonly method: string };
      if (body.method === "getSignaturesForAddress") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ signature, slot: 11, err: null }] }), { status: 200 });
      }
      if (String(input).includes("publicnode.com")) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: 429, message: "rate limited" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { slot: 11, meta: { logMessages: [] } } }), { status: 200 });
    });
    const response = await servePumpTradeHistory(
      new Request("https://sunder.test/api/market/pump-history?mint=So11111111111111111111111111111111111111112&decimals=9"),
      fetcher as unknown as typeof fetch,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sunder-market-provider")).toBe("solana-foundation");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
