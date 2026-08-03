import { fetchPumpTradeHistory, serializePumpTradeHistory } from "../../src/solana/market.js";

const OFFICIAL_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export async function servePumpTradeHistory(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405, headers: { allow: "GET" } });
  }
  const url = new URL(request.url);
  const mint = url.searchParams.get("mint") ?? "";
  const decimals = Number(url.searchParams.get("decimals"));
  if (!BASE58_ADDRESS.test(mint) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return Response.json({ error: "Invalid Pump history request." }, { status: 400 });
  }
  try {
    const trades = await fetchPumpTradeHistory({
      mint,
      decimals,
      rpcUrl: OFFICIAL_SOLANA_RPC_URL,
      limit: 96,
      signal: AbortSignal.timeout(8_000),
      fetcher,
    });
    return new Response(serializePumpTradeHistory(trades), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=0, s-maxage=8, stale-while-revalidate=30, stale-if-error=180",
        "x-content-type-options": "nosniff",
        "x-sunder-market-source": "pump-confirmed-rpc",
      },
    });
  } catch {
    return Response.json({ error: "Confirmed Pump history temporarily unavailable." }, { status: 503 });
  }
}

export default {
  fetch(request: Request): Promise<Response> {
    return servePumpTradeHistory(request);
  },
};
