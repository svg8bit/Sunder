import { describe, expect, it, vi } from "vitest";
import { proxySolanaRpc } from "../api/solana/rpc";

function rpcRequest(method = "getBalance", origin?: string): Request {
  return new Request("https://sunder.test/api/solana/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
  });
}

describe("same-origin Solana RPC boundary", () => {
  it("uses the official read RPC first and a bounded public fallback", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 7 } }), { status: 200 }));
    const response = await proxySolanaRpc(rpcRequest(), fetcher as unknown as typeof fetch);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sunder-rpc-source")).toBe("publicnode-fallback");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never blindly retries an ambiguous signed submission", async () => {
    const fetcher = vi.fn(async () => { throw new DOMException("signal timed out", "TimeoutError"); });
    const response = await proxySolanaRpc(rpcRequest("sendTransaction"), fetcher as unknown as typeof fetch);
    expect(response.status).toBe(504);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await response.text()).toContain("delivery state is unknown");
  });

  it("rejects unsupported and cross-origin RPC access", async () => {
    expect((await proxySolanaRpc(rpcRequest("requestAirdrop"))).status).toBe(400);
    expect((await proxySolanaRpc(rpcRequest("getBalance", "https://attacker.test"))).status).toBe(403);
  });
});
