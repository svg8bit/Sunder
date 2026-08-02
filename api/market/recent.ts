const UPSTREAM_URL = "https://lite-api.jup.ag/tokens/v2/recent";
const MAX_RESPONSE_BYTES = 2_000_000;

export async function proxyRecentTokens(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405, headers: { allow: "GET" } });
  }

  try {
    const upstream = await fetcher(UPSTREAM_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_500),
      cache: "no-store",
    });
    if (!upstream.ok) {
      return Response.json({ error: "Market provider temporarily unavailable." }, { status: 503 });
    }
    const body = await upstream.text();
    if (body.length > MAX_RESPONSE_BYTES) return Response.json({ error: "Market provider response exceeded the safety limit." }, { status: 502 });
    const payload: unknown = JSON.parse(body);
    if (!Array.isArray(payload) || payload.length > 500) return Response.json({ error: "Market provider returned an invalid payload." }, { status: 502 });
    return Response.json(payload, {
      headers: {
        "cache-control": "public, max-age=0, s-maxage=5, stale-while-revalidate=25, stale-if-error=120",
        "x-content-type-options": "nosniff",
        "x-sunder-market-source": "jupiter-tokens-v2",
      },
    });
  } catch {
    return Response.json({ error: "Market provider temporarily unavailable." }, { status: 503 });
  }
}

export default {
  fetch(request: Request): Promise<Response> {
    return proxyRecentTokens(request);
  },
};
