# Sunder executor runbook

The executor is a separate, loopback-only Node.js process. It builds, simulates, requests signatures over a Unix socket, submits through health-weighted relays, tracks canonical confirmation, applies bounded retries and writes an append-only JSONL audit. The Vercel UI never contains an executor signer or private relay credentials.

## Security boundary

- Never place a private key, seed, mnemonic, or secret key in an environment variable. Startup rejects `SUNDER_*` key-material variables.
- `SUNDER_SIGNER_SOCKET` is the only signing boundary. The signer must independently enforce allowed networks, accounts, programs/contracts, fee caps and spend limits.
- The HTTP control plane binds only to loopback and rejects `0.0.0.0` or a public address.
- State-changing endpoints require a bearer token read from a non-world-accessible file. The token is not an environment variable.
- Provider acceptance is only `submitted`. The executor reports success only after Solana confirmation or a canonical EVM receipt at the required depth.
- Account queues are serialized per network and public funding address to prevent accidental nonce collisions.

## Build and install

```bash
cd /opt/sunder
npm ci --ignore-scripts
npm run build
sudo install -d -o root -g sunder -m 0750 /etc/sunder
sudo install -o root -g sunder -m 0644 deploy/systemd/sunder-executor@.service /etc/systemd/system/sunder-executor@.service
sudo install -o root -g sunder -m 0640 .env.example /etc/sunder/executor-testnet.env
sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/sunder/executor-api-token'
sudo chown sunder:sunder /etc/sunder/executor-api-token
sudo chmod 0600 /etc/sunder/executor-api-token
sudo systemctl daemon-reload
```

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
