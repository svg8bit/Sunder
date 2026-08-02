# Local performance evidence

Measured on the isolated Sunder VPS on 2026-08-02 UTC with Node.js/Vitest. These are local in-memory execution-path measurements, not external network latency claims or an SLA.

| Path | Samples | Measured p95 | Target | Result |
|---|---:|---:|---:|---|
| Deterministic hot rule evaluation | 2,000 | 0.009 ms | < 5 ms | Passed |
| In-memory transaction manifest build, excluding RPC | 500 | 0.029 ms | < 25 ms | Passed |
| First healthy in-memory relay dispatch after signature availability | 500 | 0.005 ms | < 10 ms | Passed |

Reproduce with:

```bash
npm run benchmark
```

The test emits measured values and fails when a target is exceeded. Real quote, simulation, signer, relay and confirmation latency depends on selected providers and chain conditions and is deliberately excluded from these local targets.

## Rendered terminal evidence

Measured with `agent-browser vitals` against the loopback production Vite preview at `/swap`, using the real Mainnet discovery path and a warm anonymous-provider cache. These numbers describe this VPS, not public internet latency or an SLA.

| Viewport | TTFB | FCP | LCP | CLS |
|---|---:|---:|---:|---:|
| Desktop `1908 x 832` | 4.3 ms | 204 ms | 632 ms | 0.000 |
| Mobile `390 x 844` | 1.3 ms | 112 ms | 476 ms | 0.000 |

The terminal route chunk is `65.20 kB` (`20.14 kB` gzip). TradingView Lightweight Charts is isolated in a dynamic `168.14 kB` (`54.09 kB` gzip) chunk, so the chart implementation does not block the initial application shell. The main CSS bundle is `79.45 kB` (`15.26 kB` gzip).

Market discovery uses a bounded same-origin Vercel Function with `s-maxage=5`, `stale-while-revalidate=25` and `stale-if-error=120`, plus a direct anonymous-provider fallback and a two-minute validated browser cache. This reduces duplicate upstream calls without presenting cached data as a live transaction result.
