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

The Axiom captures define component anatomy, density and trading conventions; Sunder retains its own brand, zero-platform-fee disclosure, confirmation semantics and security boundary.

## Findings

There are no remaining actionable P0, P1 or P2 findings.

- Fonts and typography: compact monospaced labels, numeric alignment, uppercase table headers and hierarchy match the dense terminal source. Micro-token prices now use the familiar compact `0.0ₙ` notation; the chart uses readable `$K` market-cap labels instead of scientific notation.
- Spacing and layout rhythm: the wallet tabs, summary, search/create toolbar, select-all row, signer rows and action column closely follow the Axiom inventory rhythm. The Sunder panel intentionally includes confirmed-flow/PnL blocks below the source table.
- Colors and visual tokens: the source's near-black surfaces, thin dividers and restrained status color treatment are preserved with Sunder orange, mint and red semantic tokens.
- Image and icon fidelity: token/provider images remain real remote assets; wallet, key, explorer and delete actions use the existing icon library. No placeholder or handcrafted SVG replaces a visible source asset.
- Copy and content: `Create wallet` is immediate; each row has public address, confirmed SOL balance, signer state, export, explorer and delete actions. Security copy states browser-local encryption and backup risk without pretending cross-device custody.

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

## Interaction and browser evidence

- Browser: `agent-browser` against the loopback Vite application.
- Desktop: create first wallet, create second wallet, auto-selection, Buy/Sell modes, percentage controls, export warning/reveal, reload persistence, wallet History, live balance state, market-cap legend and live Pump tape.
- Mobile: `390 x 844`, natural stacked trade/wallet panels, immediate wallet creation, selection and no horizontal overflow.
- Desktop reload result: `walletRows=2`, `selected=2`, no create dialog; single-wallet persistence was separately observed before the second create.
- Mobile result: `walletRows=1`, `selected=1`, `dialog=false`, `scrollWidth=innerWidth=390`.
- Fresh post-HMR desktop and mobile console collections contained no warning or error entries.
- No funded Mainnet transaction was submitted during visual QA. Success remains impossible before canonical RPC confirmation.

## Focused comparison conclusion

The focused side-by-side comparison shows the required Axiom anatomy: tab strip, active-wallet total, selected count, search, one-click create, selection checkboxes, wallet name/address, balance, holdings/signer status and row actions. Sunder's narrower floating panel is an intentional draggable-terminal adaptation, not missing functionality. Focused chart evidence shows chronological reserve-price candles and a normal `$19.5K–$26K` market-cap scale.

## Accepted P3 differences

- Sunder does not reproduce Axiom branding, server custody, private-key import, proprietary historical indexer or unrelated navigation.
- New Pump bonding-curve history is accumulated from confirmed live events in the current session; a project-scoped historical OHLC provider can deepen history later without changing the chart.
- Embedded wallets persist only in the current browser profile. Users must export a backup before clearing site data; no cross-device account backend is claimed.

final result: passed
