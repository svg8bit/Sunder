# Production readiness matrix

This matrix distinguishes implemented code from configured infrastructure and independently observed on-chain evidence. A selectable Mainnet mode is not a funded Mainnet claim.

| Capability | Solana Devnet | Solana Mainnet | Ethereum Sepolia | Ethereum Mainnet |
|---|---|---|---|---|
| UI family/network mode | Implemented | Implemented | Implemented | Implemented |
| Browser wallet and balance | Wallet Standard implemented | Wallet Standard implemented | EIP-1193/wagmi implemented | EIP-1193/wagmi implemented |
| Safe verification transaction | Executable one-lamport self-transfer; wallet/funds required | Test-only action disabled | Executable zero-value self-transfer; wallet/gas required | Test-only action disabled |
| Launch adapter | Pump boundary implemented; no fabricated deploy | Pump quote/build implemented | Fixed-supply ERC-20 deploy implemented | Direct funded deploy locked |
| Swap quote/build | Pump SDK quote/buy | Interactive Jupiter Swap V2 build with `platformFeeBps=0`; Pump route observed | V2/V3/V4 official paths | V2/V3/V4 official paths |
| Exact simulation | Implemented | Implemented | `eth_call` + `estimateGas` | `eth_call` + `estimateGas` |
| Read-only live acceptance | Test fixtures only | Fresh confirmed Pump event → Jupiter `Pump.fun` route → two unsigned RPC simulations passed on 2026-08-02; `137186` CU and `5004` lamport fee estimate | Test fixtures only | Not run |
| Relays | Standard RPC; private relays optional | RPC/Jito/Nozomi/0slot adapters; credentials absent | RPC/Flashbots adapter | RPC/Flashbots adapter; operator config absent |
| Confirmation | Signature poll/subscription + expiry | Same | Receipt depth + canonical hash + replacement/reorg | Same |
| Persistent executor | Built and service-tested | Built but locked | Built and service-tested | Built but locked |
| External signer | Interface and socket protocol implemented; not provisioned | Not provisioned | Interface and socket protocol implemented; not provisioned | Not provisioned |
| Funded on-chain acceptance evidence | Not run on this VPS; requires RPC signature and expected account/action state | Not run | Not run on this VPS; requires canonical receipt and exact transaction intent | Not run |
| Current execution state | Requires test wallet and funds | **Interactive wallet-signed swaps enabled; persistent executor locked** | Requires test wallet, RPC and signer config | **Locked** |

## What is working without further infrastructure

- All product screens, navigation, responsive Solana/EVM selectors and chain-specific fields.
- Local draft/project/watch-wallet/audit workflows with no secret storage or fake on-chain state.
- Independent engine, Solana/EVM adapters, relay routing, retry, risk and confirmation tests.
- Browser connect/balance/simulation/sign/confirmation code paths when a compatible wallet is present.
- Solana Mainnet live recent-pool feed through Jupiter's anonymous public-lite host, confirmed Pump trade tape, direct zero-Sunder-fee Jupiter build/simulation/sign/submission path and exact confirmed wallet-delta ledger. The anonymous discovery feed is best-effort; a project-scoped server-side Jupiter key is still required before claiming a data-provider SLA.
- A live Mainnet read-only acceptance run used a current Pump event and active public taker to build and simulate a `0.001 SOL` buy twice through the Jupiter `Pump.fun` route. It did not request a signature, submit a transaction, or spend funds.
- Per-arm canonical execution cap of one to three confirmations and deterministic signer-aware wallet-basket planning; watch-only addresses are excluded.
- Fixed-supply ERC-20 bytecode generation and deployment encoding.
- Executor build, liveness, readiness matrix, authentication, kill switch and Mainnet lock tests.

## What remains intentionally locked

- Funded Solana Mainnet launch and unattended sniper execution; manual browser-wallet swaps are separately enabled and always user-signed.
- Any funded Ethereum Mainnet launch, swap or sniper execution.
- Persistent automated execution until a policy signer socket, exact public funding address and credential files are provisioned.
- Solana private relays until their endpoints/credentials and verified tip recipient are configured.
- Tax/CREATE2 launch factories until an audited/verified factory address and exact simulation path are configured.
- Complete historical/unrealized portfolio PnL until a project-scoped indexer and live valuation source are configured. The current ledger intentionally reports only confirmed session/browser history and excludes unvalued holdings.

## Dependency audit boundary

The release pins Vite `6.4.3` and PostCSS `8.5.18`, which removes the directly actionable high-severity build-tool findings present in the earlier lockfile. The remaining `npm audit --omit=dev` findings are transitive to the official Pump SDK / legacy Solana `web3.js` stack: the unpatched `bigint-buffer` native binding and an older `uuid` path. GitHub's advisory lists no patched `bigint-buffer` release.

Sunder therefore disables dependency lifecycle scripts in the committed `.npmrc`. A clean `npm ci --ignore-scripts` followed by the full production build was verified on this VPS, so the vulnerable native binding is not compiled and the dependency uses its pure-JavaScript path. This is a mitigation, not a claim that the upstream audit is clean. Any future dependency update must preserve the official Pump behavior, repeat the clean-install/build test, and rerun the complete chain-adapter suite. Mainnet automation remains locked independently of this boundary.

The next Mainnet step is one deliberately small owner-approved acceptance transaction after every checklist item in [the executor runbook](EXECUTOR_RUNBOOK.md) is green. Acceptance requires RPC verification of the canonical signature/receipt, the exact submitted transaction, the expected funding account and the expected action state. Explorer display is useful secondary evidence, but cannot replace those RPC checks.
