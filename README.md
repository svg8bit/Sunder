# Sunder

Sunder is a self-custody Solana and Ethereum execution console with launch, wallet, sniper, swap, task, tracking and audit workflows. It is an independent product with familiar operational labels and a strict rule: provider acceptance, simulation, or a predicted address is never reported as on-chain success.

The application supports Solana Mainnet and Ethereum Mainnet as product modes. Devnet and Sepolia are the safe verification environments. Funded Mainnet execution is implemented behind explicit readiness gates and remains locked until RPC, signer, relay, funding, budgets and operator confirmation are configured.

## Product areas

- Dashboard, Projects, Wallets, XID and Leaders
- Launch Studio with Quick Deploy, Bundle, Snipe, LBS and Dev only modes
- Chain-agnostic P0 Sniper Engine
- Swap Manager, Buy Tasks, Auto TP, Smart Sell and Anti-Sniper
- Tracker, notifications, Audit Trail, Settings and in-product Docs
- Solana Wallet Standard and EVM EIP-1193 browser-wallet verification
- Separate persistent executor with Unix-socket signing and JSONL audit

Sunder does not implement fake volume, candle painting, wash trading, mixer/evasion, aged-wallet sales or fabricated deployment history. Safe alternatives are bounded DCA, rebalancing, transparent distribution, deterministic simulation and honest analytics.

## Architecture

The execution path is independently testable:

```text
EventSource -> RuleEvaluator -> QuoteAdapter -> TransactionAdapter -> Simulator
  -> WalletAdapter -> health-weighted RelayRouter -> ConfirmationAdapter
  -> bounded RetryController -> RiskEngine -> AuditSink
```

Solana adapters cover Pump quoting/building, fresh blockhashes, compute-unit policy, RPC/Jito/Nozomi/0slot submission and signature confirmation. EVM adapters cover Uniswap V2/V3/V4-aware routing, EIP-1559 nonce-preserving replacement, standard RPC/Flashbots Protect and canonical receipt/finality/reorg tracking.

See [Architecture](docs/ARCHITECTURE.md), [Production readiness](docs/PRODUCTION_READINESS.md), [Executor runbook](docs/EXECUTOR_RUNBOOK.md), [rendered design QA](docs/design-qa.md) and the mandatory [handoff source of truth](docs/HANDOFF.md).

## Local development

Requirements: Node.js 22+, npm and a browser wallet for interactive chain verification.

```bash
npm ci --ignore-scripts
npm run dev
```

Copy `.env.example` only when custom public RPC endpoints or executor configuration are needed. Never add private keys, seeds, mnemonics or secret keys to `.env` or the browser.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run benchmark
npm run build
npm run test:sites
npm run test:e2e
npm run test:all
```

`npm run build` deterministically recompiles the fixed-supply ERC-20 artifact with pinned `solc@0.8.30`, builds the Vite UI, compiles the executor and prepares the Sites/Vercel output.

### Rendered desktop and mobile QA

Start the loopback-only development server in one terminal, then run both Playwright projects:

```bash
npm run dev
npx playwright test --project=desktop
npx playwright test --project=mobile
```

The rendered source comparison and current screenshots are recorded in [design-qa.md](docs/design-qa.md) and `artifacts/qa/`. Review Launch Studio, Sniper, Swap Manager, the family/network selector, wallet modal, mobile drawer, explorer links and Mainnet locks; confirm there is no horizontal overflow or browser-console error.

### Vercel release and production smoke

Vercel runs `npm run verify:vercel` as its build gate. After deploying the dedicated Sunder project, run the external HTTPS smoke against the returned production URL:

```bash
vercel deploy --prod
npm run smoke:production -- https://your-sunder-project.vercel.app
```

Then open `/launch`, `/sniper`, `/swap` and `/docs` in desktop and mobile browser viewports. Verify the Sunder shell, route rewrites, security headers, network persistence, wallet connection UI and locked Mainnet actions. This post-deploy check is separate from a local preview and must use the actual production URL.

## Runtime separation

- UI: static Vite application suitable for a dedicated Vercel project.
- Executor: loopback-only Node.js service on port 4174 by default; never exposed by the Vercel deployment.
- Signer: separate policy-enforcing process reached only through a restricted Unix socket.
- Secrets: credential files or provider secret stores; never browser variables or repository files.

The executor is intentionally not started with a funded signer by repository setup. Follow [the runbook](docs/EXECUTOR_RUNBOOK.md) and pass every readiness gate before any Mainnet acceptance transaction.
