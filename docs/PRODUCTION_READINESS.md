# Production readiness matrix

This matrix distinguishes implemented code from configured infrastructure and independently observed on-chain evidence. A selectable Mainnet mode is not a funded Mainnet claim.

| Capability | Solana Devnet | Solana Mainnet | Ethereum Sepolia | Ethereum Mainnet |
|---|---|---|---|---|
| UI family/network mode | Implemented | Implemented | Implemented | Implemented |
| Browser wallet and balance | Wallet Standard + encrypted embedded signer implemented | Multi-connector Wallet Standard registry plus browser-local AES-GCM vault and passphrase-encrypted backup/restore; selected signer balances poll confirmed RPC every 10 s | EIP-1193/wagmi implemented | EIP-1193/wagmi implemented |
| Safe verification transaction | Executable one-lamport self-transfer; wallet/funds required | Test-only action disabled | Executable zero-value self-transfer; wallet/gas required | Test-only action disabled |
| Launch adapter | Pump boundary implemented; no fabricated deploy | Pump quote/build implemented | Fixed-supply ERC-20 deploy implemented | Direct funded deploy locked |
| Swap quote/build | Pump SDK quote/buy | Interactive Jupiter Swap V2 basket with `platformFeeBps=0`; one build/simulation/signature/confirmation per selected connected signer | V2/V3/V4 official paths | V2/V3/V4 official paths |
| Exact simulation | Implemented | Implemented | `eth_call` + `estimateGas` | `eth_call` + `estimateGas` |
| Read-only live acceptance | Test fixtures only | Fresh Jupiter `Pump.fun` route for `0.002 SOL` → unsigned simulation passed on 2026-08-03; `202592` CU, `5398` lamport fee estimate and canonical `isBlockhashValid=true` | Test fixtures only | Not run |
| Relays | Standard RPC; private relays optional | Standard RPC + Jito enabled in the isolated operator runtime; Nozomi/0slot adapters remain unconfigured | RPC/Flashbots adapter | RPC/Flashbots adapter; operator config absent |
| Confirmation | Signature poll/subscription + expiry | Same | Receipt depth + canonical hash + replacement/reorg | Same |
| Persistent executor | Built and service-tested | Isolated loopback service running; all readiness gates passed on 2026-08-03 under one bounded acceptance rule | Built and service-tested | Built but locked |
| External signer | Interface and socket protocol implemented; not provisioned | Policy signer provisioned over a protected Unix socket for the dedicated operator address | Interface and socket protocol implemented; not provisioned | Not provisioned |
| Funded on-chain acceptance evidence | Not run on this VPS; requires RPC signature and expected account/action state | Not run | Not run on this VPS; requires canonical receipt and exact transaction intent | Not run |
| Current execution state | Requires test wallet and funds | **Interactive one-click wallet-signed swaps enabled; bounded operator sniper armed, but no matching funded execution is yet canonically confirmed** | Requires test wallet, RPC and signer config | **Locked** |

## What is working without further infrastructure

- All product screens, navigation, responsive Solana/EVM selectors and chain-specific fields.
- Local draft/project/watch-wallet/audit workflows with no plaintext secret storage or fake on-chain state.
- Independent engine, Solana/EVM adapters, relay routing, retry, risk and confirmation tests.
- Browser connect/balance/simulation/sign/confirmation code paths when a compatible wallet is present.
- Solana Mainnet live recent-pool feed through a bounded five-second Vercel CDN cache with direct-provider and two-minute real-data browser fallbacks, confirmed Pump trade tape, observed-data-only TradingView Lightweight Charts candles, direct zero-Sunder-fee Jupiter build/simulation/sign/submission path and exact confirmed wallet-delta ledger. The anonymous discovery feed is best-effort; a project-scoped server-side Jupiter key is still required before claiming a data-provider SLA.
- Connected Phantom/Solflare/Backpack-style Wallet Standard sessions can be selected together. Buy amount applies per selected signer; Sell percentage is calculated per selected signer's token balance. One Buy/Sell click obtains a fresh route, performs unsigned simulation, requests the required wallet signature, simulates the signed bytes, submits and waits for canonical RPC confirmation. Every wallet still signs independently; partial failure stops the basket, and retries skip already RPC-confirmed wallets.
- A live Mainnet read-only acceptance run used a current Pump event and active public taker to build and simulate a `0.001 SOL` buy twice through the Jupiter `Pump.fun` route. It did not request a signature, submit a transaction, or spend funds.
- `Create wallet` generates an embedded Solana signer client-side without a modal, encrypts the secret immediately under a non-extractable AES-GCM device key in IndexedDB, inserts it in both Wallets surfaces and auto-selects it for terminal fan-out. The warned export action decrypts Base58 only on demand. The whole vault can be exported/restored as a PBKDF2-SHA256 + AES-256-GCM passphrase-encrypted file; tests prove the file excludes the plaintext Base58 key, rejects a wrong passphrase and restores the matching signing address. Phantom/Solflare/Backpack connectors remain available from the header and reconnect safely when supported. Wallet selection, public history and receipts are browser-local; no account-synced custody backend is claimed.
- Persistent public connector/session metadata, ten-second confirmed-RPC SOL balance refresh and signer-aware wallet-basket planning; watch-only addresses are excluded from every signing path.
- Fixed-supply ERC-20 bytecode generation and deployment encoding.
- Executor build, liveness, readiness matrix, authentication and kill-switch tests. The isolated Mainnet instance returned HTTP 200 for `/health` and `/ready` on 2026-08-03; all 14 gates passed, its Pump log source was running, and unrelated launches were skipped without spending funds.

## What remains intentionally locked

- The first funded sniper acceptance remains unverified until a newly created Pump token matches the narrow `SUNDER` keyword rule and the resulting transaction is canonically confirmed. The armed policy spends `0.001 SOL`, permits two bounded attempts and stops after one confirmed execution.
- General multi-user unattended automation remains locked until each user has an explicit, isolated signer policy and funding boundary. A Phantom connection authorization can persist, but Phantom must still approve each new transaction; Sunder never caches a reusable transaction signature.
- Any funded Ethereum Mainnet launch, swap or sniper execution.
- Nozomi and 0slot remain unavailable until separate Sunder-scoped endpoints/credentials are configured; the current operator runtime has standard RPC and Jito only.
- Tax/CREATE2 launch factories until an audited/verified factory address and exact simulation path are configured.
- Complete historical/unrealized portfolio PnL until a project-scoped indexer and live valuation source are configured. The current ledger intentionally reports only confirmed session/browser history and excludes unvalued holdings.
- Private-key/seed import, plaintext key persistence, server custody or unattended browser signing. Solana embedded creation/export is explicitly limited to the encrypted device-local vault and interactive use; persistent automation uses a separately provisioned policy signer.
- Automatic cross-device/user-account wallet sync. The current build persists in the browser profile and provides an encrypted offline vault backup; a future project-scoped auth/storage service must preserve the same encrypted, non-server-custodial boundary.

## Dependency audit boundary

The release pins Vite `6.4.3` and PostCSS `8.5.18`, which removes the directly actionable high-severity build-tool findings present in the earlier lockfile. The remaining `npm audit --omit=dev` findings are transitive to the official Pump SDK / legacy Solana `web3.js` stack: the unpatched `bigint-buffer` native binding and an older `uuid` path. GitHub's advisory lists no patched `bigint-buffer` release.

Sunder therefore disables dependency lifecycle scripts in the committed `.npmrc`. A clean `npm ci --ignore-scripts` followed by the full production build was verified on this VPS, so the vulnerable native binding is not compiled and the dependency uses its pure-JavaScript path. This is a mitigation, not a claim that the upstream audit is clean. Any future dependency update must preserve the official Pump behavior, repeat the clean-install/build test, and rerun the complete chain-adapter suite. The bounded signer and risk policies remain mandatory independently of this dependency boundary.

The next Mainnet step is to create one deliberately named Pump token containing `SUNDER` while the one-shot acceptance rule is armed. Acceptance requires RPC verification of the canonical signature, the exact submitted transaction, the expected funding account and the resulting token balance. Explorer display is useful secondary evidence, but cannot replace those RPC checks.
