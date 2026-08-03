# Sunder executor runbook

The executor is a separate, loopback-only Node.js process. It builds, simulates, requests signatures over a Unix socket, submits through health-weighted relays, tracks canonical confirmation, applies bounded retries and writes an append-only JSONL audit. A second `sunder-signer` process decrypts one dedicated key only in memory and independently validates the raw Solana transaction. The Vercel UI never contains an executor signer or private relay credentials.

## Security boundary

- Never place a private key, seed, mnemonic, or secret key in an environment variable. Startup rejects `SUNDER_*` key-material variables.
- `SUNDER_SIGNER_SOCKET` is the only signing boundary. The signer must independently enforce allowed networks, accounts, programs/contracts, fee caps and spend limits.
- The bundled Solana signer accepts exactly one fee payer and one Pump buy, plus explicit Compute Budget, an approved Jito tip, and optional create/create-idempotent ATA instructions whose payer and owner are the signer itself. It rejects direct token-program instructions, unknown programs, non-Jito SOL transfers, changed manifests, excessive Pump spend, tips or compute fees.
- The HTTP control plane binds only to loopback and rejects `0.0.0.0` or a public address.
- State-changing endpoints require a bearer token read from a non-world-accessible file. The token is not an environment variable.
- Provider acceptance is only `submitted`. The executor reports success only after Solana confirmation or a canonical EVM receipt at the required depth.
- Account queues are serialized per network and public funding address to prevent accidental nonce collisions.
- On startup, canonical confirmations in the append-only audit hydrate per-rule confirmation caps, cooldowns, and per-rule/per-network daily spend. Keep the audit file durable and instance-scoped; deleting or replacing it invalidates those safety counters and requires an operator review before execution resumes.

## Build and install

```bash
cd /opt/sunder
npm ci --ignore-scripts
npm run build
sudo install -d -o root -g sunder -m 0750 /etc/sunder
sudo install -o root -g sunder -m 0644 deploy/systemd/sunder-executor@.service /etc/systemd/system/sunder-executor@.service
sudo install -o root -g sunder -m 0644 deploy/systemd/sunder-signer.service /etc/systemd/system/sunder-signer.service
sudo install -o root -g sunder -m 0640 .env.example /etc/sunder/executor-testnet.env
sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/sunder/executor-api-token'
sudo chown sunder:sunder /etc/sunder/executor-api-token
sudo chmod 0600 /etc/sunder/executor-api-token
sudo systemctl daemon-reload
```

Create `/etc/sunder/signer.env` with only the socket and file paths shown in `.env.example`. Fetch the current official Jito tip accounts from `getTipAccounts`, then initialize the dedicated signer once:

```bash
sudo install -d -o sunder-signer -g sunder -m 0710 /etc/sunder/signer
sudo -u sunder-signer env SUNDER_SIGNER_SOCKET=/run/sunder-signer/signer.sock \
  SUNDER_SIGNER_KEYSTORE_FILE=/etc/sunder/signer/keystore.json \
  SUNDER_SIGNER_KEK_FILE=/etc/sunder/signer/kek \
  SUNDER_SIGNER_POLICY_FILE=/etc/sunder/signer/policy.json \
  node dist/executor/packages/signer/src/init.js \
  --network solana:mainnet \
  --jito-tip-accounts <comma-separated-current-official-accounts> \
  --max-pump-spend-lamports 1100000 \
  --max-tip-lamports 10000 \
  --max-compute-unit-limit 300000 \
  --max-compute-unit-price-micro-lamports 100000
```

The initializer prints only the public funding address. It refuses to overwrite any signer material. Never paste that command with secret material: it takes paths and public policy values only.

Edit `/etc/sunder/executor-testnet.env` and remove the browser `VITE_*` section. Configure only test networks first, the public funding addresses controlled by the signer policy, and the signer socket path. Do not start a funded signer merely to make readiness green.

## Signer protocol

The executor writes one JSON line to the Unix socket:

```json
{"version":1,"requestId":"uuid","method":"signTransaction","network":"evm:sepolia","idempotencyKey":"...","lifetime":{},"feePolicy":{},"manifest":[],"unsignedPayload":"..."}
```

The signer returns one JSON line with the same `requestId`:

```json
{"version":1,"requestId":"uuid","signature":"0x...","wireTransaction":"0x..."}
```

Solana signatures are base58 and wire transactions are base64. EVM signatures are 32-byte transaction hashes and wire transactions are raw hex. The signer must reject a manifest, account, chain, fee, or transaction that is outside its own policy.

The bundled signer currently implements the Solana side. EVM stays locked unless a separately reviewed EVM policy signer is configured.

## Persistent Pump launch automation

Set `SUNDER_AUTOMATION_ENABLED=true` and install a reviewed, mode-`0600` copy of `deploy/config/automation-mainnet.example.json`. On startup the executor subscribes to official Pump program logs at `processed` commitment for low-latency detection, decodes only `CreateEvent`, deduplicates signatures, and feeds a bounded queue. Every candidate still passes deterministic rules, a fresh Pump SDK quote, risk limits, transaction construction, simulation, signer policy, health-weighted relay routing, bounded retry and canonical RPC confirmation.

This source is direct Solana program traffic. PumpPortal is not required or configured: the browser's confirmed-trade polling affects only terminal display latency and is not in the executor path.

The example rule is deliberately inert until `REPLACE_WITH_REQUIRED_TOKEN_KEYWORD` is changed and top-level `enabled` is set to `true`. Never change it to a catch-all rule for the first funded acceptance run. Use one keyword, creator allowlist or exact mint and `maxConfirmedExecutions: 1` first.

- Automation status: authenticated `GET /v1/automation`
- Event source: Pump `CreateEvent` program logs over the configured WebSocket/RPC provider
- Queue: bounded by `SUNDER_AUTOMATION_MAX_QUEUE`, serialized by the executor funding account
- Success: only `confirmed` or `finalized` from canonical RPC; a Jito/RPC acceptance is only `submitted`
- Expiry: use canonical `isBlockhashValid` and perform a final signature lookup before returning `expired`; never compare a slot-like provider response with `lastValidBlockHeight`

## Test-network activation

1. Keep `SUNDER_MAINNET_ENABLED=false` and leave the Mainnet operator confirmation empty.
2. Configure Devnet and/or Sepolia RPC, the exact public funding address, API token file and signer socket.
3. Start the isolated instance: `sudo systemctl enable --now sunder-executor@testnet`.
4. Check liveness: `curl --fail http://127.0.0.1:4174/health`.
5. Check gates: `curl --fail http://127.0.0.1:4174/ready`.
6. Query authenticated relay state using `Authorization: Bearer <token read locally from the token file>`; never paste it into logs or documentation.
7. Submit a bounded test-network execution and query RPC for the canonical signature/receipt plus the expected account and action state. Use the explorer only as supplementary evidence.

The test-network path is ready only when RPC, token file, signer socket and matching public funding address are all configured. A signer socket existing on disk is not proof that it holds funds or will approve a request.

## Mainnet activation checklist

Mainnet remains locked unless every readiness gate passes:

1. Reviewed HTTPS Mainnet RPC.
2. Policy-limited external signer socket for the exact public funding address.
3. Dedicated relay: Jito/Nozomi/0slot for Solana or Flashbots Protect/private submission for Ethereum.
4. Positive network-specific budgets, with the daily budget at least the transaction budget: `SUNDER_SOLANA_MAINNET_MAX_SPEND_LAMPORTS` / `SUNDER_SOLANA_MAINNET_MAX_DAILY_SPEND_LAMPORTS` and `SUNDER_EVM_MAINNET_MAX_SPEND_WEI` / `SUNDER_EVM_MAINNET_MAX_DAILY_SPEND_WEI`.
5. Verified funding appropriate to the bounded acceptance transaction.
6. `SUNDER_MAINNET_ENABLED=true`.
7. Exact `SUNDER_OPERATOR_CONFIRMATION=CONFIRM_MAINNET_EXECUTION` set by the operator immediately before activation.
8. Kill switch tested and inactive.
9. A deliberately small acceptance transaction verified through RPC: canonical signature/receipt, exact submitted transaction, expected funding account and expected action state. Then cross-check the explorer as secondary evidence.

For a zero-subscription bootstrap, Sunder can use a best-effort public RPC plus Jito's official transaction endpoint. Public RPCs have rate limits and no SLA, and Jito's default unauthenticated allowance is rate-limited per IP and region. This is suitable for a tightly bounded first acceptance wallet, not a promise of competitive production latency. Move to a project-scoped provider (for example a free Helius project tier) before onboarding external funded users.

The first funded Solana Mainnet pipeline acceptance completed on 2026-08-03. Its canonical signature, exact token output, wallet delta, fee/rent breakdown, false-expiry reconciliation and verified boundary are recorded in [the acceptance evidence](evidence/2026-08-03-solana-mainnet-sniper-acceptance.md).

Do not infer Mainnet readiness from HTTP 200 at a relay, a transaction hash, a predicted contract address, or a simulation. Disable immediately with the authenticated `POST /v1/kill-switch` endpoint or stop the service.

## Operations

- Liveness: `GET /health`
- Readiness matrix: `GET /ready` or `GET /v1/readiness`
- Relay health: authenticated `GET /v1/relay-health?network=evm:sepolia`
- Execution: authenticated `POST /v1/executions`
- In-memory recent audit: authenticated `GET /v1/audit?executionId=...`
- Persistent audit: the `SUNDER_EXECUTOR_AUDIT_FILE` path inside the instance StateDirectory (for example `/var/lib/sunder-executor-testnet/audit.jsonl`), mode `0600`
- Kill switch: authenticated `POST /v1/kill-switch` with `{"enabled":true}`

After changing configuration, restart the executor and re-check `/ready`. Never expose port 4174 through a public firewall or Vercel rewrite.
