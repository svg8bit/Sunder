# Solana Mainnet sniper acceptance — 2026-08-03

This record contains public on-chain evidence for one deliberately bounded Sunder executor transaction. It contains no RPC credential, API token, signer material or private key.

## Scope

- Network: Solana Mainnet
- Trigger: protected exact-mint execution built from a real Pump `CreateEvent`
- Mint: `2wGkvwH7Cs8VzPgvYvLmDMVk2rKTN6GCQqjkYmeXpump` (`Gropyer`)
- Funding address: `94eDGaXDbxDjixHMesdHeUueLvkZHEznW96mYWBSjUWE`
- Requested input: `1,000,000` lamports (`0.001 SOL`)
- Rule: exact mint, one attempt, one confirmed execution, `5%` maximum slippage and `25%` maximum price impact
- Relays: standard Solana RPC and Jito; PumpPortal, Nozomi and 0slot were not used
- Sunder platform fee: `0`

## Preflight

The mint owner is Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`). The first unsigned preflight exposed a legacy-token-program assumption and failed before signing. The builder was corrected to resolve the mint owner on-chain and pass the actual Token or Token-2022 program through Pump SDK and associated-token-account construction.

The corrected unsigned simulation passed with:

- route: `Pump bonding curve`
- price impact: `0 bps`
- compute units consumed: `107,029`
- estimated network, priority and Jito fee: `18,500` lamports
- signer policy cap: `1,100,000` Pump spend lamports

## Canonical result

- Signature: [`2ky1Hz1GHFLCFN7msfjDLjBLH5gFn7BobGr2TzdN9GoBZLcs8N4YFf22TnPiNXq21SwkKRMAmvMU4AojXeFf2BK9`](https://explorer.solana.com/tx/2ky1Hz1GHFLCFN7msfjDLjBLH5gFn7BobGr2TzdN9GoBZLcs8N4YFf22TnPiNXq21SwkKRMAmvMU4AojXeFf2BK9)
- RPC confirmation: `finalized`
- RPC error: `null`
- Slot: `436,946,654`
- Block time: `2026-08-03T09:38:26Z`
- Token output: `35,323.892686 Gropyer` (`35,323,892,686` atomic units)
- Token account: `7vxCCyWGAU7K6uoYdJf4WdP2pLhNp1Y7Qq1Q3dRdx6kJ`
- SOL balance: `0.015 SOL` before, `0.010063021 SOL` after
- Exact wallet SOL delta: `-0.004936979 SOL`
- Canonical transaction fee: `17,500` lamports
- Jito tip: `1,000` lamports
- New Token-2022 associated-token-account rent: `2,074,080` lamports
- New Pump user-volume-accumulator rent: `1,847,363` lamports
- Pump trade-side account deltas: `997,036` lamports

The larger wallet delta than the `0.001 SOL` trade input is explained by the two first-use rent deposits, not a Sunder fee. Rent-bearing accounts remain on-chain; closing an eligible token account later can reclaim its rent, while protocol-owned state follows the protocol's rules.

## Confirmation correction

Both relays accepted the same canonical signature. The initial tracker incorrectly classified the transaction as expired because the configured provider returned a slot-like value from `getBlockHeight`, which is not comparable to `lastValidBlockHeight`. Independent canonical RPC lookup found the transaction finalized with `err: null` and the exact token balance above.

The confirmation adapter now uses canonical `isBlockhashValid` and performs one final signature lookup before declaring expiry. The append-only audit contains the original observation plus a canonical reconciliation pair, and risk hydration records this exact rule as one confirmed execution with `1,000,000` lamports of daily spend. No second transaction was submitted.

## Verified boundary

This proves the funded Pump quote/build/simulation/policy-signing/RPC+Jito submission/canonical-confirmation/audit path on Solana Mainnet. The Pump program-log source was independently live and processing `CreateEvent` traffic, but this funded acceptance used the protected exact-mint trigger rather than waiting for the armed `SUNDER` keyword rule to match. It does not claim catch-all unattended trading, external-user custody, Nozomi/0slot latency, or guaranteed profit.
