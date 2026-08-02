# Sunder terminal design QA

## Final comparison target

- User-provided Axiom terminal reference: `artifacts/qa/axiom-terminal-trade-reference.png` (`1919 x 857`).
- User-provided Axiom wallet reference: `artifacts/qa/axiom-wallets-reference.png` (`969 x 464`).
- Accepted Sunder product sources: `docs/design/sunder-desktop-source.png` and `docs/design/sunder-mobile-source.png`.
- Final desktop terminal: `artifacts/qa/terminal-desktop-multiwallet-live-final.png` (`1908 x 832`).
- Equal-viewport full comparison: `artifacts/qa/terminal-floating-panels-side-by-side-final.png` (`3816 x 832`).
- Focused panel comparison: `artifacts/qa/terminal-floating-panels-focused-final.png` (`1814 x 600`).
- Final wallet/history states: `artifacts/qa/terminal-wallet-history-final.png`, `artifacts/qa/terminal-create-wallet-modal-final.png`, `artifacts/qa/wallets-create-history-desktop-final.png`, and `artifacts/qa/wallets-history-desktop-final.png`.
- Final mobile states: `artifacts/qa/terminal-mobile-top-multiwallet-final.png`, `artifacts/qa/terminal-mobile-chart-multiwallet-final.png`, `artifacts/qa/terminal-mobile-trade-multiwallet-final.png`, `artifacts/qa/terminal-mobile-wallet-multiwallet-final.png`, and `artifacts/qa/terminal-create-wallet-modal-mobile-final.png` (`390 x 844`).

The Axiom capture is used for component anatomy and density, not copied branding. Sunder retains its own navigation, colors, truthful execution labels and self-custody boundary.

## Result

There are no remaining actionable P0, P1 or P2 visual findings.

- Desktop matches the source hierarchy: dense token strip, live launch scanner, candlestick workspace, trade tape, Buy/Sell panel and compact multi-wallet panel.
- Trade and wallet panels can be dragged independently by their headers, are clamped on-screen, preserve position and stacking order across reload, support keyboard arrow movement, and have a visible Reset panels action.
- Mobile switches to a natural stacked layout. The scanner reserves a fixed responsive height so the first live provider response does not move the chart or panels.
- The wallet panel has working Wallets and History states. Tasks opens the Sniper task console; Spot returns to the buy workspace.
- `Create wallet` opens a responsive provider-owned self-custody flow. With no extension installed, the QA browser honestly showed official Phantom, Solflare and Backpack install/create actions instead of a fake account.
- The dedicated Wallets screen shows connected signers, live balance status, watch inventory and wallet-linked history.

## Data and execution truthfulness

- Market rows come from Jupiter Tokens V2 through the bounded same-origin cache/direct fallback.
- Candles contain only observed Jupiter prices or confirmed Pump events; there is no synthetic historical series.
- Pump tape links only decoded confirmed program events to Solscan.
- Buy/Sell input uses familiar percent/SOL units. Basis points remain an internal conversion only.
- Sunder platform fee is `0 bps`; network, Pump/AMM, priority, account-rent and optional relay fees remain visible.
- A multi-signer basket builds and simulates one transaction per selected signer, requests each wallet signature separately, and reports success only after canonical RPC confirmation.
- No funded Mainnet transaction was submitted during visual QA.

## Interaction evidence

Browser: `agent-browser` against the loopback production Vite build.

- Live Solana Mainnet token discovery, token selection stability, New/Moving/Liquid/Pump filters, search, candle interval controls, chart pan/zoom/crosshair and Pump tape were exercised.
- Buy and Sell modes, Market/Limit/Advanced, amount presets, sell percentages, slippage percentage, priority and MEV state were exercised.
- Panel drag changed the trade-panel position; reload preserved it. Keyboard ArrowRight moved the focused panel by 12 pixels. Reset restored the non-overlapping default layout.
- Wallets/History tabs and both Create wallet entry points were exercised.
- A focused registry test proves that a Wallet Standard session appears after connection, persists only its public connector ID, and restores with `{ autoConnect: true, allowInteractiveFallback: false }`.
- Desktop and mobile browser error collections were empty. Console collections were empty.
- Desktop viewport: `scrollWidth = clientWidth = 1908`.
- Mobile viewport: `scrollWidth = clientWidth = 390`.

The QA Chrome profile had no Wallet Standard extension and no funded signer. Therefore the release evidence intentionally contains no invented wallet row, balance, signature or transaction success. A real Phantom/Solflare/Backpack acceptance transaction requires the user's extension, funded public account and explicit in-wallet approval.

## Performance evidence

Loopback production-build measurements are VPS-local evidence, not an internet SLA. The scanner and token identity reserve their final geometry before provider data arrives, eliminating the material mobile layout shift found during the final pass. Exact final measurements and bundle sizes are recorded in `docs/PERFORMANCE.md`.

## Accepted P3 differences

- Sunder does not reproduce Axiom custody, private-key export, proprietary branding or unrelated navigation.
- Historical candles are limited to real observations available to the current deployment. A project-scoped OHLC indexer can increase history depth later without changing the chart or trade layout.
- Browser-local connector/history persistence is not cross-device account storage.

final result: passed
