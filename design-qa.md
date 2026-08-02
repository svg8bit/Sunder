# Sunder terminal design QA

## Comparison target and evidence

- Source visual truth: `artifacts/qa/axiom-terminal-trade-reference.png` (`1919 x 857`) and `artifacts/qa/axiom-wallets-reference.png` (`969 x 464`).
- Accepted Sunder product sources: `docs/design/sunder-desktop-source.png` and `docs/design/sunder-mobile-source.png`.
- Desktop implementation: `artifacts/qa/terminal-wallet-embedded-desktop-final.png` (`1280 x 633`, CSS viewport `1280 x 720`, DPR 1).
- Focused wallet implementation: `artifacts/qa/terminal-wallet-embedded-focused-final.png` (`570 x 474`).
- Same-input side-by-side wallet comparison: `artifacts/qa/terminal-wallet-embedded-side-by-side-final.png` (`1600 x 700`).
- Corrected chart evidence: `artifacts/qa/terminal-chart-reserve-mcap-final.png` (`617 x 453`).
- Export warning state: `artifacts/qa/terminal-wallet-export-warning-final.png` (`1280 x 633`); no private key is visible in the artifact.
- Mobile wallet implementation: `artifacts/qa/terminal-wallet-embedded-mobile-final.png` (`390 x 844`) captured at DPR 1.
- Current Mainnet terminal: `artifacts/qa/terminal-desktop-reset.png` (`1920 x 900`) and `artifacts/qa/terminal-mobile-local.png` (`390 x 844`, full page).
- Current Mainnet Sniper: `artifacts/qa/sniper-mobile-local.png` (`390 x 844`, full page).
- Required combined visual input: `artifacts/qa/terminal-mainnet-side-by-side.png`, generated from `artifacts/qa/terminal-mainnet-comparison.html` and inspected as one image.

The Axiom captures define component anatomy, density and trading conventions; Sunder retains its own brand, zero-platform-fee disclosure, confirmation semantics and security boundary.

## Findings

There are no remaining actionable P0, P1 or P2 findings.

- Fonts and typography: compact monospaced labels, numeric alignment, uppercase table headers and hierarchy match the dense terminal source. Micro-token prices now use the familiar compact `0.0ₙ` notation; the chart uses readable `$K` market-cap labels instead of scientific notation.
- Spacing and layout rhythm: the wallet tabs, summary, search/create toolbar, select-all row, signer rows and action column closely follow the Axiom inventory rhythm. The Sunder panel intentionally includes confirmed-flow/PnL blocks below the source table.
- Colors and visual tokens: the source's near-black surfaces, thin dividers and restrained status color treatment are preserved with Sunder orange, mint and red semantic tokens.
- Image and icon fidelity: token/provider images remain real remote assets; wallet, key, explorer and delete actions use the existing icon library. No placeholder or handcrafted SVG replaces a visible source asset.
- Copy and content: `Create wallet` is immediate; each row has public address, confirmed SOL balance, signer state, export, explorer and delete actions. Security copy states browser-local encryption and backup risk without pretending cross-device custody.
- URL identity: selecting a token now changes the canonical route to `/meme/<mint>?chain=sol`; direct loads restore the same token and the strip exposes a copy-link action.
- Historical chart density: the terminal backfills up to 48 confirmed mint transactions through bounded Solana RPC requests, decodes official Pump `TradeEvent` logs, merges/deduplicates them with the live WebSocket stream, and caches the result for 60 seconds. No candle is synthesized for an interval without a confirmed trade.

## Comparison history

### Iteration 1 — blocked

- [P1] Candle direction and scale were misleading. Pump candles used average execution price, equal-second events were reversed, delayed slots could insert bars in the past, and tiny values rendered in scientific notation.
- [P1] `Create wallet` opened provider guidance instead of creating the selected, tradable wallet row requested in the source flow.

### Iteration 2 — passed

- Pump TradeEvent candles now use post-trade virtual-reserve spot price, order by timestamp then confirmed slot, reject delayed older slots at the live watermark, and anchor once to Jupiter's current USD market-cap index.
- Visible terminal prices use compact crypto notation and the chart legend/axis use USD market cap; browser evidence contained no scientific-notation price labels.
- `Create wallet` now generates a Solana Keypair client-side with no modal, AES-GCM encrypts the secret under a non-extractable device key in IndexedDB, inserts and auto-selects the row, refreshes its confirmed balance, and persists it across reload.
- Two wallets were created in the browser flow. Both rows appeared, both were selected, Buy/Sell reported two signers, and the History tab contained two public `Embedded wallet created` entries.
- Export was exercised through the warning dialog. The explicit Reveal action produced an 88-character Base58 value and Copy/Download controls; the value was neither printed nor captured. A unit test restored the matching address and produced a 64-byte transaction signature.

### Iteration 3 — Mainnet sniper and chart follow-up passed

- The earlier chart calibration was still recalculated whenever a new trade or Jupiter snapshot arrived. That could shift every historical candle vertically even though the underlying reserve-price ratios had not changed. The market-cap calibration is now frozen once per mint and resets only when the instrument changes.
- The chart now opens with bounded confirmed Pump history instead of showing only trades observed after page load. The newest canonical reserve event anchors the initial market-cap scale, same-slot observations are ordered by slot/signature, and all intervals retain real OHLC geometry.
- TradingView Lightweight Charts remains the renderer, with required visible TradingView attribution. It is the open-source chart renderer, not TradingView's proprietary hosted datafeed; Solana RPC/Pump events remain the data truth.
- A desktop mouse drag moved the Trade panel from its default position and persisted `{x,y,z}` in `sunder:terminal-floating-panels:v1`; Reset panels restored the accepted composition. Wallets remained independently draggable.
- Browser wallet QA created `Sunder Wallet 1` without a dialog, inserted and selected it immediately, then reloaded the permanent token URL. The signer row, selection and IndexedDB vault (`sunder-solana-embedded-vault`) persisted; no key material was printed or captured.
- Solana Sniper now renders the provisioned isolated executor address and honest `Funding + confirmation` state. Jito is displayed as configured only when its public status endpoint is present at build time.

## Interaction and browser evidence

- Browser: `agent-browser` against the loopback Vite application.
- Desktop: create first wallet, create second wallet, auto-selection, Buy/Sell modes, percentage controls, export warning/reveal, reload persistence, wallet History, live balance state, market-cap legend and live Pump tape.
- Mobile: `390 x 844`, natural stacked trade/wallet panels, immediate wallet creation, selection and no horizontal overflow.
- Desktop reload result: `walletRows=2`, `selected=2`, no create dialog; single-wallet persistence was separately observed before the second create.
- Mobile result: `walletRows=1`, `selected=1`, `dialog=false`, `scrollWidth=innerWidth=390`.
- Fresh post-HMR desktop and mobile console collections contained no warning or error entries.
- No funded Mainnet transaction was submitted during visual QA. Success remains impossible before canonical RPC confirmation.
- Current desktop viewport passed `scrollWidth=clientWidth=1920`; current mobile terminal passed `scrollWidth=clientWidth=390`.
- Current permanent route observed in Chromium: `/meme/HCPtSBVKbV71UmE3ggccV3uNwapthUMMf63o7qGYpump?chain=sol`.
- Current chart evidence observed `53` confirmed Pump events in the first pass and `160` after the bounded history/live merge; the axis used `$K` market-cap labels rather than scientific notation.

## Focused comparison conclusion

The focused side-by-side comparison shows the required Axiom anatomy: tab strip, active-wallet total, selected count, search, one-click create, selection checkboxes, wallet name/address, balance, holdings/signer status and row actions. Sunder's narrower floating panel is an intentional draggable-terminal adaptation, not missing functionality. Focused chart evidence shows chronological reserve-price candles and a normal `$19.5K–$26K` market-cap scale.

## Accepted P3 differences

- Sunder does not reproduce Axiom branding, server custody, private-key import, proprietary historical indexer or unrelated navigation.
- Axiom's proprietary historical indexer is deeper than the bounded public-RPC backfill. Sunder intentionally caps each token selection at 48 confirmed transaction fetches and caches the result to preserve free-provider limits; a project-scoped indexer can extend depth without changing the chart model.
- Embedded wallets persist only in the current browser profile. Users must export a backup before clearing site data; no cross-device account backend is claimed.

final result: passed
