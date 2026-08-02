# Local performance evidence

Measured on the isolated Sunder VPS on 2026-08-02 UTC with Node.js/Vitest. These are local in-memory execution-path measurements, not external network latency claims or an SLA.

| Path | Samples | Measured p95 | Target | Result |
|---|---:|---:|---:|---|
| Deterministic hot rule evaluation | 2,000 | 0.013 ms | < 5 ms | Passed |
| In-memory transaction manifest build, excluding RPC | 500 | 0.028 ms | < 25 ms | Passed |
| First healthy in-memory relay dispatch after signature availability | 500 | 0.004 ms | < 10 ms | Passed |

Reproduce with:

```bash
npm run benchmark
```

The test emits measured values and fails when a target is exceeded. Real quote, simulation, signer, relay and confirmation latency depends on selected providers and chain conditions and is deliberately excluded from these local targets.
