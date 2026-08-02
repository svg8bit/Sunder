# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Sunder Project Rules

- Speak to the user in Russian. Keep code, filenames, comments, documentation, and identifiers in English.
- Sunder is an independent public product. On the ArcTrenches VPS it must live under `/opt/sunder`; do not edit, restart, reuse secrets from, or deploy into `/opt/arctrenches`.
- Treat `docs/HANDOFF.md` as the current product and research source of truth.
- The accepted visual sources are `docs/design/sunder-desktop-source.png` and `docs/design/sunder-mobile-source.png`. Match them closely; this is an application, not a marketing landing page.
- For the trading terminal, the user's Axiom desktop captures supplied on 2026-08-02 supersede the older terminal composition while preserving Sunder branding and truthful execution states. Match the dense token scanner, real candlestick workspace, market tabs, and Axiom-derived trade and wallet component anatomy.
- The trade panel must use familiar trading units and controls: Buy/Sell, Market/Limit/Advanced, SOL or token amount presets, slippage shown as a percentage (with basis-point conversion only internal), priority fee, MEV mode/tip, selected-wallet count, simulation, and explicit signing/confirmation progress.
- The wallet panel must show connected and watch-only accounts in a compact table with selection, labels, addresses, live balances/holdings, signer capability, and select-all behavior. Selected connected signers may fan out a trade; watch-only accounts must never be presented as signers.
- The Axiom-derived trade panel replaces the current `Direct trade` card and the wallet table replaces the current `Sniper basket` card. Neither is permanently docked to the right: on desktop both are draggable by their headers anywhere within the terminal viewport, clamped on-screen, and persist positions and stacking order across navigation and reload. Mobile uses an accessible stacked/drawer layout rather than off-screen floating panels.
- Persist browser-wallet connector choice and reconnect safely across routes/reloads. Do not add private-key or seed import/export to the web app; Phantom, Solflare, Backpack and other Wallet Standard wallets are the Solana boundary, and WalletConnect/Reown requires a new Sunder-scoped project ID.
- Sniper is P0. Build the real execution boundary and tests before claiming it is operational.
- Never store, transmit, log, or commit private keys or seed phrases. Browser wallet signing is self-custody. A persistent executor must use a separately configured encrypted signer policy.
- Never report launch, buy, or sell success until the signature/account is verified through RPC.
- Do not implement fake volume, candle painting, mixer/evasion promises, aged-wallet sales, wash trading, or fabricated deploy history. Use the legitimate replacements defined in the handoff.
- Sunder is dual-chain: Solana Mainnet and Ethereum/EVM Mainnet are required production modes. Devnet and Sepolia are test environments, not the final product scope.
- Keep funded Mainnet execution locked until the corresponding RPC, relay, signer, risk limits, funding, and explicit operator confirmation are configured, but implement the Mainnet adapters, selectors, UI, and readiness checks now.
- Before every deployment, run lint, typecheck, tests, build, rendered desktop/mobile QA, and a production URL smoke test.
- Use a separate process/service for the low-latency executor. Never install it into an existing ArcTrenches service or port.
