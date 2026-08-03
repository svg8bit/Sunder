# Local performance evidence

Measured on the isolated Sunder VPS on 2026-08-03 UTC with Node.js/Vitest. These are local in-memory execution-path measurements, not external network latency claims or an SLA.

| Path | Samples | Measured p95 | Target | Result |
|---|---:|---:|---:|---|
| Deterministic hot rule evaluation | 2,000 | 0.011 ms | < 5 ms | Passed |
| In-memory transaction manifest build, excluding RPC | 500 | 0.038 ms | < 25 ms | Passed |
| First healthy in-memory relay dispatch after signature availability | 500 | 0.006 ms | < 10 ms | Passed |

Reproduce with:

```bash
npm run benchmark
```

The test emits measured values and fails when a target is exceeded. Real quote, simulation, signer, relay and confirmation latency depends on selected providers and chain conditions and is deliberately excluded from these local targets.

## Rendered terminal evidence

Measured with `agent-browser vitals` against the loopback production Vite preview at `/swap`, using the real Mainnet discovery path and a warm anonymous-provider cache. These numbers describe this VPS, not public internet latency or an SLA.

| Viewport | TTFB | FCP | LCP | CLS |
|---|---:|---:|---:|---:|
| Desktop `1440 x 900` | 2.9 ms | 168 ms | 612 ms | 0.020 |
| Mobile `390 x 844` | 2.8 ms | 140 ms | 520 ms | 0.000 |

The terminal route chunk is `75.45 kB` (`23.45 kB` gzip). The explicit private-key export remains isolated in a `2.85 kB` (`1.37 kB` gzip) chunk, and encrypted vault backup/restore is separately lazy-loaded in a `4.15 kB` (`1.74 kB` gzip) chunk. TradingView Lightweight Charts is isolated in a dynamic `168.14 kB` (`54.09 kB` gzip) chunk, so neither the chart nor recovery UI blocks the initial application shell. The main CSS bundle is `82.25 kB` (`15.66 kB` gzip).

Market discovery uses a bounded same-origin Vercel Function with `s-maxage=5`, `stale-while-revalidate=25` and `stale-if-error=120`, plus a direct anonymous-provider fallback and a two-minute validated browser cache. This reduces duplicate upstream calls without presenting cached data as a live transaction result.
