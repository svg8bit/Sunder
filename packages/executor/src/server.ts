import { timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { toSerializableAudit, type ChainNetworkId, type ExecutionRequest } from "../../sniper-engine/src/index.js";
import { parseExecutorConfig } from "./config.js";
import { evaluateReadiness, type ExecutorReadiness } from "./readiness.js";
import { createExecutorRuntime, ExecutorRuntimeError, type ExecutorRuntime } from "./runtime.js";

const VERSION = "0.1.0";
const MAX_BODY_BYTES = 256 * 1_024;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const atomicSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/).transform((value) => BigInt(value));
const networkSchema = z.enum(["solana:devnet", "solana:mainnet", "evm:sepolia", "evm:mainnet"]);
const eventSchema = z.object({
  id: z.string().min(1).max(128),
  source: z.enum(["manual", "websocket", "program-log", "xid", "pool"]),
  sourceCursor: z.string().min(1).max(256).optional(),
  sourceAccount: z.string().min(1).max(128).optional(),
  kind: z.enum(["manual", "new_mint", "pool_created", "x_post", "program_log"]),
  network: networkSchema,
  receivedAt: z.number().int().nonnegative(),
  target: z.string().min(1).max(128).optional(),
  mint: z.string().min(1).max(128).optional(),
  account: z.string().min(1).max(128),
  text: z.string().max(4_096).optional(),
  hasMedia: z.boolean().optional(),
  attributes: z.record(z.string().max(64), z.union([z.string().max(4_096), z.number().finite(), z.boolean()])),
});
const ruleSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  enabled: z.boolean(),
  networks: z.array(networkSchema).min(1).max(4),
  eventKinds: z.array(z.enum(["manual", "new_mint", "pool_created", "x_post", "program_log"])).min(1).max(5),
  accounts: z.array(z.string().max(128)).max(128),
  keywords: z.array(z.string().max(128)).max(128),
  regex: z.string().max(256).optional(),
  requireMedia: z.boolean(),
  allowTargets: z.array(z.string().max(128)).max(256),
  denyTargets: z.array(z.string().max(128)).max(256),
  maxSpendAtomic: atomicSchema,
  maxDailySpendAtomic: atomicSchema,
  maxSlippageBps: z.number().int().min(0).max(5_000),
  maxPriceImpactBps: z.number().int().min(0).max(10_000),
  cooldownMs: z.number().int().min(0).max(86_400_000),
  maxAttempts: z.number().int().min(1).max(10),
});
const solanaFeeSchema = z.object({
  kind: z.literal("solana"),
  computeUnitLimit: z.number().int().min(10_000).max(1_400_000),
  computeUnitPriceMicroLamports: atomicSchema,
  tipLamports: atomicSchema,
});
const evmFeeSchema = z.object({
  kind: z.literal("eip1559"),
  gasLimit: atomicSchema,
  maxFeePerGas: atomicSchema,
  maxPriorityFeePerGas: atomicSchema,
  replacementBumpBps: z.number().int().min(1_250).max(10_000),
});
const executionSchema = z.object({
  event: eventSchema,
  rules: z.array(ruleSchema).min(1).max(100),
  inputAmountAtomic: atomicSchema,
  feePolicy: z.discriminatedUnion("kind", [solanaFeeSchema, evmFeeSchema]),
  relayFanout: z.number().int().min(1).max(4),
}).superRefine((value, context) => {
  if (value.event.network.startsWith("solana:") && value.feePolicy.kind !== "solana") {
    context.addIssue({ code: "custom", message: "Solana events require a Solana fee policy.", path: ["feePolicy"] });
  }
  if (value.event.network.startsWith("evm:") && value.feePolicy.kind !== "eip1559") {
    context.addIssue({ code: "custom", message: "EVM events require an EIP-1559 fee policy.", path: ["feePolicy"] });
  }
});

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(400, "invalid-content-type", "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "body-too-large", "Request body exceeds 256 KiB.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function readApiToken(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) return undefined;
    const token = (await handle.readFile("utf8")).trim();
    return token.length >= 24 ? token : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function authorized(request: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) return false;
  const prefix = "Bearer ";
  const header = request.headers.authorization;
  if (!header?.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length));
  const target = Buffer.from(expected);
  return provided.length === target.length && timingSafeEqual(provided, target);
}

class AccountScheduler {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, number>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const pending = this.#pending.get(key) ?? 0;
    if (pending >= 100) throw new HttpError(429, "account-queue-full", "Account execution queue is full.");
    this.#pending.set(key, pending + 1);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.catch(() => undefined).then(() => tail);
    this.#tails.set(key, chain);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      const remaining = (this.#pending.get(key) ?? 1) - 1;
      if (remaining === 0) this.#pending.delete(key); else this.#pending.set(key, remaining);
      if (this.#tails.get(key) === chain) this.#tails.delete(key);
    }
  }
}

interface ExecutorServerOptions {
  readonly evaluate?: (config: ReturnType<typeof parseExecutorConfig>, killSwitch?: boolean) => Promise<ExecutorReadiness>;
  readonly createRuntime?: (config: ReturnType<typeof parseExecutorConfig>, readiness: ExecutorReadiness) => Promise<ExecutorRuntime>;
}

export async function startExecutorServer(environment: NodeJS.ProcessEnv = process.env, options: ExecutorServerOptions = {}) {
  const config = parseExecutorConfig(environment);
  const evaluate = options.evaluate ?? evaluateReadiness;
  const initialReadiness = await evaluate(config);
  const runtime = await (options.createRuntime ?? createExecutorRuntime)(config, initialReadiness);
  const scheduler = new AccountScheduler();
  const startedAt = Date.now();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${config.host}:${config.port}`);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { status: "ok", service: "sunder-executor", version: VERSION, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000) });
      }
      if (request.method === "GET" && (url.pathname === "/ready" || url.pathname === "/v1/readiness")) {
        const readiness = await evaluate(config, runtime.killSwitch());
        return json(response, readiness.ready ? 200 : 503, readiness);
      }
      const token = await readApiToken(config.apiTokenFile);
      if (url.pathname.startsWith("/v1/") && !authorized(request, token)) {
        response.setHeader("www-authenticate", "Bearer");
        return json(response, 401, { error: "unauthorized" });
      }
      if (request.method === "GET" && url.pathname === "/v1/relay-health") {
        const network = url.searchParams.get("network") as ChainNetworkId | null;
        if (network && !config.networks.includes(network)) return json(response, 400, { error: "unsupported-network" });
        return json(response, 200, { relays: runtime.relayHealth(network ?? undefined) });
      }
      if (request.method === "GET" && url.pathname === "/v1/audit") {
        const executionId = url.searchParams.get("executionId") ?? undefined;
        return json(response, 200, { records: toSerializableAudit(runtime.audit.records(executionId)) });
      }
      if (request.method === "POST" && url.pathname === "/v1/kill-switch") {
        const body = z.object({ enabled: z.boolean() }).parse(await readBody(request));
        runtime.setKillSwitch(body.enabled);
        return json(response, 200, { killSwitch: runtime.killSwitch(), changedAt: new Date().toISOString() });
      }
      if (request.method === "POST" && url.pathname === "/v1/executions") {
        const body = executionSchema.parse(await readBody(request)) as ExecutionRequest;
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        const readiness = await evaluate(config, runtime.killSwitch());
        const accountKey = body.event.network.startsWith("evm:") ? body.event.account?.toLowerCase() : body.event.account;
        const key = `${body.event.network}:${accountKey ?? "unresolved"}`;
        const result = await scheduler.run(key, () => runtime.execute(body, readiness, controller.signal));
        return json(response, 200, result);
      }
      return json(response, 404, { error: "not-found" });
    } catch (error) {
      if (error instanceof z.ZodError) return json(response, 400, { error: "invalid-request", issues: error.issues });
      if (error instanceof HttpError || error instanceof ExecutorRuntimeError) {
        return json(response, error.status, { error: error.code, detail: error.message });
      }
      if (error instanceof SyntaxError) return json(response, 400, { error: "invalid-json", detail: "Request body is not valid JSON." });
      const message = error instanceof Error ? error.message : "Internal error";
      return json(response, 500, { error: "internal-error", detail: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let closePromise: Promise<void> | undefined;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise<void>((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    });
    return closePromise;
  };
  return Object.freeze({ server, config, runtime, close });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const service = await startExecutorServer();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await service.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}
