# Sunder design QA

## Comparison target

- Source visual truth: `artifacts/qa/axiom-reference.png` (the user-provided Axiom terminal capture), `1280 x 653` pixels.
- Product-wide accepted sources: `docs/design/sunder-desktop-source.png` (`1487 x 1058`) and `docs/design/sunder-mobile-source.png` (`853 x 1844`).
- Final desktop implementation: `artifacts/qa/terminal-desktop-final-production.png`, `1280 x 653` pixels at a `1280 x 653` CSS viewport and device scale factor 1.
- Final mobile implementation: `artifacts/qa/terminal-mobile-final-production.png` and `artifacts/qa/terminal-mobile-trade-final-production.png`, each `390 x 844` pixels at a `390 x 844` CSS viewport and device scale factor 1.
- Full-view normalized comparison: `artifacts/qa/terminal-desktop-side-by-side-final.png`, `2560 x 653`, containing the equal-size source and implementation in one image.
- Focused normalized comparison: `artifacts/qa/terminal-trade-dock-side-by-side-final.png`, `1120 x 390`, containing the source and implementation quick-trade/wallet regions in one image.
- State: `/swap`, Solana family, Mainnet, live Jupiter recent-token feed, confirmed Pump event stream, Wallet Standard signer disconnected, no fabricated wallet balance or execution result.

No density resampling was required for the terminal comparison. Both source and implementation were captured at exactly `1280 x 653`. The earlier product-wide accepted sources use different canvas sizes and are retained as composition references rather than treated as pixel-identical terminal states.

## Findings

There are no remaining actionable P0, P1, or P2 findings.

- [P3] Intentional chart-semantic difference
  - Location: terminal center chart.
  - Evidence: the source contains a mature candlestick history; the implementation shows only live Jupiter price observations and confirmed Pump event markers.
  - Impact: the implementation is less historically rich, but it does not invent candles or imply an indexer that is not configured.
  - Classification: accepted product-truthfulness constraint. A real OHLC indexer may replace the observation line later without changing the composition.

- [P3] Intentional product-shell difference
  - Location: global navigation.
  - Evidence: the source uses Axiom's proprietary navigation and brand; Sunder uses its own Launch Studio, Sniper, Projects, Audit Trail, Docs, chain selector, notifications, and Wallet Standard entry.
  - Impact: the interaction density and hierarchy remain close while avoiding copied branding and irrelevant destinations.
  - Classification: accepted product-identity difference.

## Required fidelity surfaces

- Fonts and typography: compact sans-serif navigation and headings plus the monospace terminal scale reproduce the dense source hierarchy. Small labels retain readable optical weight, truncation, and line height at desktop and mobile. No actionable wrapping or clipping remains.
- Spacing and layout rhythm: the desktop uses the same dense top statistics strip, left discovery rail, central market area, right trade tape, and lower-left quick-trade/wallet overlay. The mobile stack preserves order and full-width controls. Borders are square/subtle and elevation is limited to the desktop dock, matching the source's utilitarian surface treatment.
- Colors and visual tokens: near-black surfaces, low-contrast dividers, muted labels, green/red trade states, and restrained orange emphasis closely match the source. Sunder's orange brand token is intentionally retained. Focus states use a visible orange outline.
- Image quality and asset fidelity: the source screenshot remains unmodified in comparison evidence. Live token icons are HTTPS provider assets with fixed dimensions and safe fallbacks; interface icons use the consistent Lucide family. No target illustration, logo, or product imagery was replaced by handcrafted SVG/CSS art.
- Copy and content: all static copy is standalone Sunder product language. `0 bps platform`, `Build & simulate`, `Canonical RPC confirmation`, and the PnL caveat state real execution semantics. Live token names, values, fees, and trades come from providers and are not fixture claims.

## Interaction and browser evidence

- Browser: `agent-browser` with a fresh Chrome session against the production Vite build.
- Primary interactions checked: Solana/EVM family switch, Mainnet selection, rolling token refresh, token selection stability across multiple refreshes, New/Moving/Liquid/Pump filters, mint search control, live Pump subscription, quick amounts, buy/sell tabs, slippage and priority controls, fast-mode toggle, first-1/2/3 cap, disabled no-wallet execution, mobile navigation, and responsive scrolling.
- Stable live state: the same selected instrument remained selected across more than two rolling `/recent` refreshes and the tape accumulated 80 confirmed Pump events.
- Viewport resilience: desktop `scrollWidth = clientWidth = 1280`; mobile `scrollWidth = clientWidth = 390`. The mobile workspace and trade dock meet at the same boundary without overlap.
- Browser page errors: none. Final fresh production-render console messages: none.
- Local production-build vitals after reserving the token strip: TTFB `0.7 ms`, FCP `132 ms`, LCP `468 ms`, CLS `0.0`. These are VPS-local QA measurements, not an internet SLA.

## Comparison history

### Pass 1 — blocked

- [P1] The terminal heading/top bar consumed too much of the `1280 x 653` viewport and pushed the core trading controls below the fold.
- [P1] No token remained selected during the rolling recent-token refresh, leaving the primary market state empty.
- [P2] The first mobile render overflowed horizontally (`534 px` content in a `390 px` viewport).
- Evidence: `artifacts/qa/terminal-desktop-pass1.png`, `artifacts/qa/terminal-desktop-side-by-side-pass1.png`, and `artifacts/qa/terminal-mobile-pass1.png`.
- Fixes: introduced the terminal-specific compact shell, selected the highest-volume recent instrument, placed the direct-trade/wallet controls in the source-like desktop dock, and tightened responsive grid minimums.

### Pass 2 — blocked

- [P1] The desktop dock was materially too large and covered most of the market chart.
- [P2] Mobile still exceeded the viewport (`410 px` content in a `390 px` viewport).
- Evidence: `artifacts/qa/terminal-desktop-pass2.png`, `artifacts/qa/terminal-desktop-side-by-side-pass2.png`, and `artifacts/qa/terminal-mobile-pass2.png`.
- Fixes: scaled the desktop dock to `.68` with a bottom-left origin, reduced its footprint, collapsed terminal header controls on narrow screens, and removed remaining fixed-width mobile tracks.

### Pass 3 — blocked after production-state review

- The desktop composition was visually close and mobile horizontal overflow was eliminated (`390 px = 390 px`).
- [P1] A selected token could age out of Jupiter's rolling `/recent` response, resetting the live Pump tape.
- [P1] On mobile, the fixed-height workspace allowed the static trade dock to overlap the overflowing live tape.
- [P2] In the initially loading Mainnet state, inserting the token strip produced CLS `0.19`.
- Evidence: `artifacts/qa/terminal-desktop-pass3.png`, `artifacts/qa/terminal-desktop-side-by-side-pass3.png`, `artifacts/qa/terminal-mobile-pass3.png`, and the first production mobile trade capture.
- Fixes: pinned the selected provider instrument while allowing fresher provider data to win, always reserved the `67 px` token-stat strip, and switched the tablet/mobile workspace to intrinsic height.

### Final pass — passed

- Post-fix evidence: `artifacts/qa/terminal-desktop-side-by-side-final.png`, `artifacts/qa/terminal-trade-dock-side-by-side-final.png`, `artifacts/qa/terminal-mobile-final-production.png`, and `artifacts/qa/terminal-mobile-trade-final-production.png`.
- Desktop and mobile have no horizontal overflow, no component overlap, no browser errors, no console messages, stable live selection, and honest loading/locked states.
- The five fidelity surfaces and core interaction states were rechecked. Only the two accepted P3 product-truthfulness/identity differences remain.

### CodeRabbit accessibility/safety pass — blocked, fixed, then passed

- [P1] The source-like desktop dock had been visually reduced with `transform: scale(.68)`, which also reduced readable text and interaction targets.
- [P1] Wallet-basket weighting could create a zero-atomic execution for very small or zero-weight allocations.
- [P1] A rapid double click could enter the async signing path twice before React rendered its submitted phase.
- [P1] An invalid persisted trade record could invalidate the entire local ledger, and a newly constructed record was not schema-checked immediately before persistence.
- [P2] Feed headers, the mobile search font, clipboard fallback, invalid pool timestamps, ledger ordering, and README PnL scope needed bounded corrections.
- Fixes: replaced transform scaling with direct `540 px` desktop dock sizing and moved it beside the discovery rail; excluded zero-weight signers and rejected zero-atomic plans; added a synchronous ref-based execution guard; validated stored records individually and new records before persistence; aligned feed tracks; set the mobile search input to `16 px`; and added the smaller defensive checks.
- Two suggestions were deliberately not applied after verification: an explorer-placeholder selector did not match the reported element type, and substituting a token-account key for a missing SPL owner would be semantically incorrect. A proposed mint-filtered Pump subscription was also rejected after a live A/B probe observed `98` matching program-stream events and `0` mint-filter notifications; Sunder retains the official-program subscription plus decoded mint filter.
- Post-fix Browser evidence is the same final full/focused set above. The discovery rail remains independently clickable, controls are rendered at direct size, desktop/mobile overflow remains zero, and fresh console/error collections are empty.

This `passed` result applies only to rendered visual/design and interaction-state validation. Funded Mainnet automation remains locked until project-scoped RPC/relay configuration, a policy signer, bounded risk limits, funding, and exact operator confirmation all pass the executor runbook.

final result: passed
