const OFFICIAL_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const PUBLICNODE_SOLANA_RPC_URL = "https://solana-rpc.publicnode.com";
const MAX_REQUEST_BYTES = 2_000_000;
const MAX_RESPONSE_BYTES = 6_000_000;

const ALLOWED_METHODS = new Set([
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getGenesisHash",
  "getHealth",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTransaction",
  "getTokenAccountsByOwner",
  "getVersion",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly method: string;
  readonly params: readonly unknown[];
}

function parseRequest(value: unknown): JsonRpcRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<JsonRpcRequest>;
  if (candidate.jsonrpc !== "2.0" || !ALLOWED_METHODS.has(String(candidate.method)) || !Array.isArray(candidate.params)) return undefined;
  if (!(typeof candidate.id === "string" || typeof candidate.id === "number" || candidate.id === null)) return undefined;
  return candidate as JsonRpcRequest;
}

async function upstreamRpc(url: string, body: string, timeoutMs: number, fetcher: typeof fetch): Promise<Response> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}.`);
  const payload = await response.text();
  if (payload.length > MAX_RESPONSE_BYTES) throw new Error("Upstream response exceeded the safety limit.");
  JSON.parse(payload);
  return new Response(payload, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-sunder-rpc-source": url === OFFICIAL_SOLANA_RPC_URL ? "solana-foundation" : "publicnode-fallback",
    },
  });
}

export async function proxySolanaRpc(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405, headers: { allow: "POST" } });
  }
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin) return Response.json({ error: "Cross-origin RPC access denied." }, { status: 403 });
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return Response.json({ error: "RPC request too large." }, { status: 413 });

  let body: string;
  let rpcRequest: JsonRpcRequest | undefined;
  try {
    body = await request.text();
    if (body.length > MAX_REQUEST_BYTES) return Response.json({ error: "RPC request too large." }, { status: 413 });
    rpcRequest = parseRequest(JSON.parse(body));
  } catch {
    return Response.json({ error: "Invalid JSON-RPC request." }, { status: 400 });
  }
  if (!rpcRequest) return Response.json({ error: "Unsupported JSON-RPC request." }, { status: 400 });

  const write = rpcRequest.method === "sendTransaction";
  try {
    return await upstreamRpc(OFFICIAL_SOLANA_RPC_URL, body, write ? 8_000 : 4_500, fetcher);
  } catch {
    if (write) {
      return Response.json({ error: "Solana submission response unavailable; delivery state is unknown." }, { status: 504, headers: { "cache-control": "private, no-store" } });
    }
  }
  try {
    return await upstreamRpc(PUBLICNODE_SOLANA_RPC_URL, body, 4_500, fetcher);
  } catch {
    return Response.json({ error: "Solana RPC providers temporarily unavailable." }, { status: 503, headers: { "cache-control": "private, no-store" } });
  }
}

export default {
  fetch(request: Request): Promise<Response> {
    return proxySolanaRpc(request);
  },
};
