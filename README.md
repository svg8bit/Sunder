# Sunder

Sunder is a self-custody Solana and Ethereum execution console with launch, wallet, sniper, swap, task, tracking and audit workflows. It is an independent product with familiar operational labels and a strict rule: provider acceptance, simulation, or a predicted address is never reported as on-chain success.

The application supports Solana Mainnet and Ethereum Mainnet as product modes. Devnet and Sepolia are the safe automated verification environments. Interactive Solana Mainnet swaps can be simulated and explicitly signed by one or more selected Wallet Standard browser wallets; persistent funded Mainnet automation remains locked until RPC, signer, relay, funding, budgets and operator confirmation are configured.

## Product areas

- Dashboard, Projects, Wallets, XID and Leaders
- Launch Studio with Quick Deploy, Bundle, Snipe, LBS and Dev-only modes
- Chain-agnostic P0 Sniper Engine
- Swap Manager, Buy Tasks, Auto TP, Smart Sell and Anti-Sniper
- Solana live terminal with recent-pool discovery, confirmed Pump trade events, TradingView Lightweight Charts candles built only from observed data, direct Jupiter quotes, selected-wallet fan-out, live SOL balances and exact confirmed realized net cash-flow PnL for tracked inventory; unvalued holdings and incomplete history remain explicitly excluded
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

Solana adapters cover Pump quoting/building, fresh blockhashes, compute-unit policy, RPC/Jito/Nozomi/0slot submission and signature confirmation. The browser Mainnet terminal adds live Jupiter-indexed pools, confirmed Pump `TradeEvent` streaming and direct Jupiter Swap V2 transaction manifests with `platformFeeBps=0`. A selected-wallet basket builds and simulates one exact transaction per connected signer, then requests signatures sequentially; a partial failure can retry only the still-pending wallets. Exact wallet deltas are recorded only after canonical RPC confirmation. Pump/AMM, network, priority, rent and optional relay fees still apply; only Sunder's platform fee is zero. EVM adapters cover Uniswap V2/V3/V4-aware routing, EIP-1559 nonce-preserving replacement, standard RPC/Flashbots Protect and canonical receipt/finality/reorg tracking.

See [Architecture](docs/ARCHITECTURE.md), [Production readiness](docs/PRODUCTION_READINESS.md), [Executor runbook](docs/EXECUTOR_RUNBOOK.md), [rendered design QA](docs/design-qa.md) and the mandatory [handoff source of truth](docs/HANDOFF.md).

## Local development

Requirements: Node.js 22+, npm and a browser wallet for interactive chain verification.

```bash
npm ci --ignore-scripts
npm run dev
```

Copy `.env.example` only when custom public RPC endpoints or executor configuration are needed. Never add private keys, seeds, mnemonics or secret keys to `.env`, source code, logs or browser text inputs.

The committed Solana Mainnet fallback is PublicNode because its HTTP and WebSocket endpoints were verified from the browser build. It is shared, best-effort infrastructure. Recent-token discovery uses a five-second Vercel CDN cache with a bounded direct-provider fallback and a two-minute browser cache so first paint is not held behind repeated anonymous provider calls. Configure a project-scoped browser-safe RPC before funded use; signer or relay credentials belong only in the private executor/signing boundary.

The web app never accepts a pasted private key/seed and never transmits secret material. `Create wallet` on Solana generates a Keypair client-side, immediately encrypts its 64-byte secret with a non-extractable AES-GCM device key in IndexedDB, inserts and selects the signer in the wallet basket, and exposes a warned explicit Base58 export for backup. Clearing browser data loses an unexported embedded wallet, and this is not cross-device account storage. Phantom, Solflare and Backpack remain available through Wallet Standard. All signer balances refresh from confirmed Mainnet RPC every 10 seconds; watch-only addresses are never treated as signers.

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

The latest rendered source comparison and current screenshots are recorded in the project-root [design-qa.md](design-qa.md), with the earlier product-wide evidence retained in [docs/design-qa.md](docs/design-qa.md) and `artifacts/qa/`. Review Launch Studio, Sniper, Swap Manager, the family/network selector, wallet modal, mobile drawer, explorer links and Mainnet locks; confirm there is no horizontal overflow or browser-console error.

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
