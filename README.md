# Sunder

Sunder is a self-custody Solana launch and execution console inspired by the workflow coverage of Vortex Deployer, rebuilt with an independent brand, auditable state, and RPC-confirmed outcomes.

The project is being transferred to the isolated `/opt/sunder` workspace on the ArcTrenches VPS. Read [`docs/HANDOFF.md`](docs/HANDOFF.md) before implementation.

## Product areas

- Sniper Engine (P0)
- Launch Studio and Quick Deploy
- Wallet roles, groups, funding, and collecting
- Projects, Swap Manager, Buy Tasks, Auto TP, Smart Sell, and Anti-Sniper
- XID event rules and dry-run approval flows
- Dashboard, Leaders, Tracker, Settings, notifications, and Audit Trail

## Safety model

Keys remain in the user's wallet. The public web app never accepts private keys. Devnet is the default executable network; Mainnet stays locked until external infrastructure and signer policy are configured and verified.

## Current stack

- React 19 + Vite
- Tailwind CSS 4
- Radix UI primitives with shadcn-style local components
- Motion micro-interactions
- `@solana/client` + `@solana/react-hooks`

See the handoff for the exact feature inventory, reference captures, architecture, and verification requirements.
