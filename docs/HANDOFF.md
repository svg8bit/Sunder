# Sunder full task handoff

This document transfers the complete user request, authenticated competitor research, technical findings, visual references, boundaries, and delivery contract to the ArcTrenches VPS task. It contains no credentials, cookies, private keys, or wallet secrets.

## User outcome

Build and publicly ship a separate product named **Sunder** that covers the useful workflows of `vortexdeployer.com` under an independent brand. The user wants familiar labels and minimal wording changes so the product is immediately understandable. The product must be fast, functional, wallet-connected, and production-oriented across **Solana Mainnet and Ethereum/EVM Mainnet**. Devnet and Sepolia are test environments, not the final product boundary. The **dual-chain Sniper Engine is P0** and must be a real execution architecture rather than a visual mock.

Required delivery:

1. Isolated project under `/opt/sunder`; never mix with `/opt/arctrenches` or any existing VPS service.
2. Public GitHub repository `svg8bit/Sunder`, committed and pushed.
3. Public Vercel production deployment in a separate Vercel project.
4. Working local preview plus production browser verification.
5. Solana Wallet Standard and Ethereum/EVM browser-wallet flows with genuinely executable Devnet and Sepolia verification transactions.
6. Implemented Solana Mainnet and Ethereum Mainnet modes, adapters, readiness checks, and UI. Funded execution remains locked until safe RPC, relay, signer, funding, and operator confirmation exist.
7. Tests, performance checks, desktop/mobile rendered QA, architecture docs, and honest capability states.

## Accepted visual direction

- Desktop source of truth: `docs/design/sunder-desktop-source.png`.
- Mobile responsive source of truth: `docs/design/sunder-mobile-source.png`.
- Style: near-black graphite/blackened-steel surfaces, subtle cold-gray borders, restrained ember orange, mint-green validation, compact technical labels, high-density professional trading console.
- No gradients, glow, excessive rounded cards, decorative landing-page illustration, fake charts, or handmade SVG icons.
- Use Lucide icons, Radix primitives, shadcn-style local components, Tailwind 4, and restrained Motion/Magic-style micro-interactions.
- The accepted desktop composition has: top product nav and network/wallet controls; left step rail; central form; right preflight summary; bottom simulation and primary transaction actions.
- Match the reference before creative improvements. The user explicitly rejected a simplified visual-only interpretation.

## Authenticated Vortex UI inventory

The source was inspected while authenticated through Telegram with the user's assistance. Relevant screenshots are under `docs/research/screenshots/`.

### Global product navigation

- Dashboard
- Projects
- Wallets
- XID
- Leaders
- Separate EVM entry
- Floating Quick action, Tracker, Help, supply calculator, notifications, themes

### Dashboard and projects

- Dashboard shows tokens launched, net SOL flow, earnings calendar, and project history. Net SOL flow is not profit and Sunder must label it honestly.
- Projects filters: All, Pending, Deployed, CTO, XID, plus search.
- Vortex displayed a success-like Swap Manager shell and predicted mint at zero balance, but Pump returned 404, Solscan had no transactions, official mainnet RPC returned `getAccountInfo.value = null`, and the project remained Pending. Sunder must never call a launch successful before RPC signature/account verification.

### Launch wizard

1. Metadata: platform, token mode, name, symbol, description, image, socials.
2. Wallets and buy allocation.
3. Buy Mode: Snipe, Bundle, LBS (launch + bundle + snipe), Dev only.
4. Overview and deploy.

Observed platforms: Pump, Bonk, Bonkers, LaunchLab, Bags, Printr. Classic SPL and Mayhem/Token-2022 modes are exposed.

### Wallets

- Project Wallets: DEV, Create, Import, Export, Fund, Collect, inventory, select all/page, swap, delete.
- Global Wallets: groups, Warmup, Dev Warmup, Create, Import, Export, Fund, Collect.
- Quick Deploy roles: Developer (1), Bundle (12 in UI; docs say up to 16), Sniper (up to 500), Task wallets.
- The competitor accepts/exports private keys through its backend. Sunder must not. Use wallet-standard connection, watch-only address groups, hardware-wallet-compatible signing, and a separately configured executor signer policy.
- Do not reproduce the marketplace for aged/exchange-funded wallets or the Dev Warmup feature intended to manufacture deploy history.

### Funding and collecting

- Funding UI exposes Disperse and Mixer modes, equal/variation/custom amounts, selected wallets, a temporary wallet, and deposit/private-key handling.
- Collect sweeps wallets above a threshold to a destination.
- Sunder replacement: transparent batched distribution signed by the connected wallet, explicit recipients/amounts, transaction preview, RPC confirmations, and audit trail. Do not claim to evade Bubblemaps and do not expose a mixer.

### Quick Deploy and sniper controls

- Wallet roles: Developer, Bundle, Sniper.
- Launch modes: Dev Only, Bundle, Snipe, LBS.
- Sniper delay presets observed in frontend:
  - Instant `[0, 0]`
  - Fast `[50, 200]` ms
  - Medium `[100, 500]` ms
  - Slow `[200, 1000]` ms
  - Custom
- Extra settings defaults observed in route code:

```json
{
  "sniper": { "delayMin": 100, "delayMax": 500 },
  "antiSniper": {
    "enabled": false,
    "thresholdPercent": 10,
    "action": "sell_all",
    "stopMode": "first_success",
    "monitorDurationSeconds": 30,
    "sniperRetryCount": 3
  },
  "smartSell": {
    "enabled": false,
    "sellPercentOnBuy": 10.5,
    "stopIfHoldingBelow": 5,
    "minSolToActivate": 0.1,
    "minMcapToActivate": 50000
  },
  "autoTP": {
    "enabled": false,
    "sellDevFirst": true,
    "sellDevAfterMs": -1,
    "sellAllAfterMs": -1,
    "levels": []
  },
  "retry": { "enabled": false, "maxRetries": 3, "retryDelayMs": 1000 },
  "feeSharing": {
    "enabled": false,
    "shareholders": [{ "address": "", "sharePercent": 100 }]
  }
}
```

### Swap Manager and tasks

- Live screen: token chart/activity, buy/sell, token stats, Settings, Tasks, Lock, Burn, Send, Wallets, Smart Sell, wallet inventory, quick sell, Sell All, Sell ex-dev.
- Buy Task: initial delay, random delay range, Full/Exact/Percentage/Range, supply guard, auto-start.
- Volume Task: buy/sell power, ranges, delays, wallet rotation, mixed sizes, candle painting, external-activity response, priority fee.
- Fake Volume: two wallets, target USD volume, max SOL/cycle, delay, Jito tip, concurrency, priority fee.
- Handswitcher, ViewBoost, HolderBoost, ProTrader Boost, Token Disperser are also exposed.
- Build Buy Task, scheduled DCA, legitimate rebalancing/distribution, strategy simulation, load testing, and honest holder analytics. Do not build fake volume, candle painting, wash trading, deceptive holder/pro-trader fabrication, or artificial engagement.

### XID

- Real-time X/Twitter feed with deploy/clone-from-post flows.
- Rule inputs: accounts, keywords, regex, event types (posts, follows, profile changes), AI instructions/model, platforms, Classic/Mayhem, dev buy, Jito tip, bundle toggle, bundle/sniper wallets, cashback, Anti-Sniper, deploy/day, max SOL/deploy, cooldown, auto/manual approval, dry-run, kill switch, require media, notifications, cost preview.
- Sunder should implement the full rule builder and deterministic dry-run simulator. Live X ingestion needs a configured provider credential and must show a locked/unconfigured state otherwise.

### Settings, leaders, and profile

- General: DEX, swap layout, transaction notifications, UI scale, activity filter.
- Swap defaults: buy/sell slippage, sniper tip (`0.001010 SOL` observed), swap tip (`0.000100 SOL` observed), stablecoin-to-SOL.
- Quick actions: buy 0.1/0.25/0.5/1 SOL; sell 25/50/75/100%; hotkeys Sell Dev, Sell All, Sell ex-dev, Start tasks, Stop tasks.
- Fund history: Disperse/Mixer.
- Leaders: public PnL, volume, win rate, wallet counts, privacy settings.
- Profile: referrals, subscription, export keys, PIN/password, rewards/cashback. Do not copy custody/key export or pay competitor subscriptions.

## Authenticated Vortex EVM inventory

The authenticated EVM application was inspected on 2026-08-02 after the user clarified that Sunder must support both Solana and Ethereum. Captures are stored as `docs/research/screenshots/vortex-evm-*.jpg`. The EVM application is mounted under `/evm`; `/evm/docs` returns a real Page not found state, so public EVM documentation was not available.

### EVM shell and chain switching

- Navigation: Dashboard, Projects, Wallets, Swap, Create Project, and a SOL button that returns to the Solana product.
- The chain selector exposes `Robinhood` and `Ethereum`.
- Explorer links observed in the frontend: `https://robinhood.cloud.blockscout.com` and `https://etherscan.io`.
- Wrapped-native addresses observed in the public config:
  - Robinhood: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
  - Ethereum WETH: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`
- Dashboard shows tokens launched, total native balance across global wallets, net ETH flow, and project history. Net flow is explicitly not profit.

### EVM projects and launch wizard

- Project filters: All, Pending, Deployed.
- Create Project offers `New Project` and `CTO` for an existing `0x` token address.
- Launchpads: `flap` (tax or no-tax) and `pons` (simple no-tax launch).
- Metadata: name, symbol, description, image, website, X, Telegram, Discord, Farcaster, chain.
- `flap` exposes optional initial native liquidity. Zero is described as a dead pool that becomes live on the first buy.
- Advanced `flap` configuration:
  - no-tax or tax mode;
  - buy and sell tax percentage;
  - 10,000-BPS distribution across marketing/dev, reflections, burn/deflation, and LP;
  - tax duration, with a frontend minimum of 86,400 seconds for taxed launches;
  - optional commission receiver;
  - anti-farmer/anti-snipe duration;
  - CREATE2 vanity salt as bytes32 or phrase.
- The frontend asks the backend to preview a CREATE2 address, but only marks it verified when the live factory simulation returns a valid address and salt. Preview failure does not block deploy.
- Wizard steps: Metadata; Wallets & Buy; Overview & Deploy.
- Wallet step actions: Create, Import, Global, Import Dev, Fund. It displays total ETH balance and allows a custom fee wallet that receives trading fees and initial-buy tokens.
- Saved launch configuration contains `launchMode`, selected wallet IDs and amounts, bundle/task/sniper wallet collections, separate bundle/sniper amounts, and `sniperIntervals` with a default `[0, 0]`.

### EVM wallet custody

- The UI explicitly states: keys are generated server-side and encrypted at rest with AES-256-GCM; private keys are later revealed through Export.
- Project and Global wallets support Create, Import, Export, Fund, Collect, groups, bulk create (up to 100), and import into a project.
- The selected chain is stored on each wallet. Global wallets from another chain are hidden from project import.
- Sunder must not reproduce this custody boundary. Browser-wallet and policy-limited signer integrations must replace server-side plaintext-key import/export.

### EVM Swap Manager and tasks

- Swap Manager includes project/token selection, chart, activity, trade panel, buy/sell, Buy Tasks, Settings, Lock, Burn, Send/Funding, Wallets, Smart Sell, Auto TP, Sell All, Sell All excluding dev, launch-buy versus other-wallet grouping, and per-wallet results.
- It detects Uniswap V2, V3, or V4 venue as a read-only value.
- Swap payloads contain project, direction, wallet IDs, `slippageBps`, execute flag, token override, buy amount in wei or sell percentage.
- The frontend supports exact, range, percentage, and full-balance Buy Task modes; initial delay; 0–600,000 ms inter-wallet jitter; slippage; optional V3 fee tier; 0–50 retries; presets; and auto-start on launch.
- It supports randomized/staggered multi-wallet sequences and first-wallet retry-until-landed behavior. Sunder may provide legitimate scheduled/rebalancing execution but must not present wash-trading or artificial-volume controls.
- WebSocket: `wss://evm.vortexdeployer.com/ws?token=...` and subscription payload `{ action: "subscribe", projectId }`.
- Observed message types: `subscribed`, `project_state`, `trades_initial`, `trade_activity`, `pool_trade`, `task_update`, `swap_leg_update`, `swap_progress`, `tp_triggered`, `smart_sell_triggered`.
- Heartbeat runs every 25 seconds; reconnect delay doubles from 500 ms up to 8 seconds.

### EVM public frontend API

- Same-origin base: `/evm/api`.
- Auth: `/auth/login`, `/auth/register`.
- Projects: `/projects`, `/projects/:id`, `/projects/:id/logo`, `/projects/:id/refresh-metadata`, `/projects/:id/state`, `/projects/:id/pnl`, `/projects/:id/trades`, `/projects/:id/candles`, `/projects/:id/pool-trades`.
- Launch: `/projects/:id/launch`, `/projects/:id/launch/preview-address`.
- Token and prices: `/token-info/:chain/:address`, `/balance/:chain/:address`, `/price/eth`.
- Wallets: project and global wallet CRUD, import/export, groups, and import-to-project endpoints.
- Tasks: project tasks, arm/start/stop/delete, task presets, Auto TP, and Smart Sell endpoints.
- Trading/funding: `/swap`, `/funding/disperse`, `/funding/collect`, `/disperser/start`, `/disperser/status/:id`.
- The public frontend still delegates key generation, transaction signing, launch, swap, and task execution to the Vortex backend; no audited public Vortex EVM contract/executor implementation was exposed.

## Vortex documentation findings

The entire public `/docs` tree was reviewed:

- Launch Guide with metadata, developer wallet, funding, buy amounts, mode selection, bundle/sniper selection, review/launch.
- CTO Guide for an existing Pump mint through metadata initialization, wallets, and Swap Manager.
- Dashboard.
- Wallets and Global Wallet groups.
- Funding and Collecting.
- Volume Task.
- Buy Task.
- Settings.

Important inconsistencies: docs show six/seven launch steps inconsistently; Bundle supports 12 in UI versus 16 in docs; Mixer appears in UI while docs say coming soon. Product behavior must be driven by Sunder's typed configuration and tests, not copied inconsistencies.

## Reconstructed Vortex frontend/backend architecture

- Next.js frontend.
- API base observed: `https://api.vortexdeployer.com/api`.
- WebSocket observed: `wss://api.vortexdeployer.com`.
- Authenticated WebSocket subscribes with `{ "action": "notifications_subscribe" }`, uses exponential reconnect up to five attempts, and receives `antisniper_triggered`.
- Quick Deploy stores `pendingFastLaunchRequest` in `sessionStorage`, navigates to Swap Manager, then calls a dynamic `fastLaunchDeploy` action.
- `/fast-launch/deploy` accepts token metadata, image/platform/quote, dev buy, launch mode, bundle/sniper wallet selections and overrides, sniper intervals/retries, Mayhem mode, cashback/buyback, Anti-Sniper, fee sharing, Buy Tasks, and Volume Tasks.
- Launch mode values observed: `launch`, `launchbundle`, `launchsnipe`, `launchbundlesnipe`.
- Other endpoint groups observed: `/fast-launch/settings`, `/fast-launch/wallets`, `/token/create`, `/mint`, `/metadata/upload`, `/wallets/*`, `/globalwallets/*`, `/tasks/*`, `/autotp/*`, `/smart-sell/*`, `/disperser/*`, `/mixer/*`, `/xid/*`, `/lock`, `/burn`, `/transfer`, `/swap`, `/token/reland`.
- No Pump or other launch-program IDs are present in the public frontend. Transaction construction/submission is hidden in the backend and appears custodial.
- Frontend admin metrics reference `nozomi`, `falcon`, and `0slot`; exact backend relay fanout is not public. Do not claim implementation details that were not observed.

## Official on-chain and relay research

- Pump public docs: <https://github.com/pump-fun/pump-public-docs>
- Pump program guide: <https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md>
- Pump program address on mainnet/devnet: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`.
- Official SDK: `@pump-fun/pump-sdk`. Verify the current package/API before integration.
- Jito low-latency submission: <https://docs.jito.wtf/lowlatencytxnsend/>. Direct validator submission, `skip_preflight=true`, bundles of up to five transactions, priority fee plus tip, minimum bundle tip, and sandwich-mitigation guidance are documented. Never skip Sunder's own local/RPC simulation merely because the relay skips preflight.
- Nozomi transaction submission: <https://use.temporal.xyz/nozomi/transaction-submission>.
- 0slot docs: <https://0slot.trade/docs.php>.
- Solana frontend docs: <https://solana.com/docs/frontend>.
- Solana retry guide: <https://solana.com/developers/guides/advanced/retry>. A send response does not guarantee landing; custom rebroadcast and explicit confirmation are required.
- The current official React/Vite template uses `@solana/client` and `@solana/react-hooks`. The local project already installed `@solana/client@1.7.0` and `@solana/react-hooks@1.4.1`.
- A verifiable official public document for the Vortex-labelled `Falcon` relay was not found. Treat it as an unverified competitor label.

## Sunder architecture contract

### Web console

- React 19 + Vite + TypeScript.
- Tailwind 4, Radix primitives, shadcn-style local components, Lucide, Motion, Sonner, Zod, React Hook Form.
- Solana: `@solana/client` + `@solana/react-hooks` with Wallet Standard auto-discovery.
- EVM: current primary-source-verified `viem`/`wagmi` browser-wallet stack with WalletConnect-compatible connectors.
- Network-family selector for Solana and EVM, plus environment selectors for Mainnet and Devnet/Sepolia.
- Browser wallet connection, live balance, simulation, signed test-network transaction, and signature/receipt confirmation for both chain families.
- Local persistent configuration may use versioned local storage for the first public build. Never store secret material.

### Sniper Engine (P0)

Implement the engine as an independently testable package/process with these stages:

1. `EventSource`: websocket/log/XID/manual/pool adapters emit normalized immutable events with chain family, chain ID, and source cursor.
2. `RuleEvaluator`: accounts, keywords, regex, media, cooldown, spend/day, target allowlist/denylist, and risk filters.
3. `QuoteProvider`: route and quote abstraction with staleness and max price-impact checks.
4. `TransactionBuilder`: chain adapter builds either a fresh-blockhash Solana transaction with compute-unit policy and optional Jito tip, or an EIP-1559 EVM transaction with nonce, gas, deadline, and replacement policy; both include an idempotency key and exact instruction/call manifest.
5. `Simulator`: pre-trade simulation, account diff, logs, estimated fee, slippage guard.
6. `Signer`: Solana Wallet Standard and EVM EIP-1193 browser wallets for interactive mode; encrypted external signer policy for an always-on executor. No HTTP private-key payloads.
7. `RelayRouter`: health-weighted Solana adapters for standard RPC, Jito, Nozomi, and 0slot; EVM adapters for standard RPC and officially documented private/MEV-protected submission such as Flashbots Protect; provider credentials only through environment/secrets.
8. `ConfirmationTracker`: Solana signature subscription/polling or EVM receipt/finality/reorg tracking; states `prepared`, `signed`, `submitted`, `processed`, `confirmed`, `finalized`, `failed`, `expired`, and `reorged` where applicable.
9. `RetryController`: Solana blockhash refresh or EVM nonce-preserving fee replacement, bounded rebroadcast, attempt budget, jitter, deduplication, and stop-on-confirmation.
10. `RiskEngine`: max spend/transaction/day, max slippage/price impact, cooldown, kill switch, allowlists, Mainnet lock, and invariant checks.
11. `AuditSink`: structured timestamps for event received, rule matched, quote, build, simulation, signature, each relay attempt, and confirmation.

Performance targets for local measurements (not external SLA promises): hot-path rule evaluation p95 under 5 ms; transaction build p95 under 25 ms excluding RPC; first relay dispatch within 10 ms after signature availability; no blocking UI work on the execution path. Record actual measurements in tests/benchmarks.

### Product screens

- Dashboard
- Launch Studio
- Sniper
- Projects
- Wallets
- XID
- Swap Manager
- Audit Trail
- Leaders
- Tracker
- Settings
- Docs

Every relevant product screen must preserve the selected chain family and render chain-specific wallet, unit, fee, relay, explorer, launchpad, quote, transaction, and confirmation controls. Do not show SOL units in EVM mode or ETH/gas semantics in Solana mode.

Use familiar control labels where functional/generic, but do not copy Vortex branding or long-form proprietary copy. Every core navigation item, tab, form control, modal, and primary CTA must work with realistic data or an honest locked/unconfigured state.

## Current local scaffold state

- Product Design `prototype` template initialized.
- Dependencies installed; see `package.json` and lockfile.
- Current source is still the empty starter (`src/App.jsx`). The remote task must convert it to TypeScript and build the product.
- Current npm registry metadata has some future/broken dist-tags. The latest Radix packages attempted to pull unpublished `@radix-ui/primitive@1.1.7`; installed versions were deliberately pinned to available compatible releases. `shadcn@4.16.1` also attempted to pull unavailable `type-is@^2.1.0`; use the installed Radix primitives and local shadcn component patterns, or pin a verified older CLI. Do not blindly run `@latest`.

## Required implementation sequence

1. Clone/open this repository in `/opt/sunder`; confirm `/opt/arctrenches` is untouched and record baseline services/ports.
2. Create/update the task goal and plan from this handoff.
3. Convert scaffold to TypeScript; add lint, typecheck, Vitest, RTL, and performance scripts.
4. Build shared domain/config/audit store and Sniper Engine package/tests first.
5. Build Solana Wallet Standard and EVM browser-wallet providers with real Devnet/Sepolia connect, balance, transfer, simulation, and confirmation flows.
6. Build all product screens and interactions using the accepted visuals, including Solana/EVM family and network selectors.
7. Add safe launch/token adapters for Devnet/Sepolia and implement production Solana Mainnet/Ethereum Mainnet modes. Keep funded execution unavailable until current official SDK behavior and external infrastructure are verified.
8. Add a chain-agnostic executor service package, `.env.example`, health/readiness endpoints, systemd unit template, and runbook. Do not start a funded Mainnet signer.
9. Run lint, typecheck, tests, build, `test:sites`, desktop/mobile Browser QA, accessibility checks, and local performance measurements.
10. Produce `design-qa.md` with source path, screenshot path, viewport, comparison history, and `final result: passed|blocked`.
11. Commit/push to the public GitHub repo.
12. Deploy the UI to a separate Vercel project and verify the public production URL in Browser.
13. Leave the production Sunder tab open for the user and report exact working/locked scope. Never describe a mocked or unconfigured Mainnet path as working.

## Definition of done

Done means the repository and public production URL exist; the accepted UI is closely matched on desktop/mobile; navigation/core controls work; Solana and EVM product modes are implemented; wallet connection and safe Devnet/Sepolia transaction paths are verifiably executable; Solana Mainnet/Ethereum Mainnet adapters and readiness states exist; the dual-chain Sniper Engine is implemented and tested; relay/signer/funded-Mainnet configuration is explicit and locked when absent; build/tests/QA pass; and no existing ArcTrenches service or secret was touched.
