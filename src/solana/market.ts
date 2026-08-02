import { getBase58Decoder, getBase64Codec, type Base64EncodedBytes } from "@solana/kit";
import { z } from "zod";

// The key-backed api.jup.ag gateway rejects anonymous browser traffic. Jupiter's
// public-lite host serves the same Tokens V2 schema and keeps the read-only
// discovery/search path usable without ever shipping an API key to the client.
export const JUPITER_TOKENS_API = "https://lite-api.jup.ag/tokens/v2";
export const PUMP_PROGRAM_ADDRESS = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const TRADE_EVENT_DISCRIMINATOR = Uint8Array.from([189, 219, 127, 211, 78, 230, 97, 238]);

const optionalNumber = z.preprocess(
  (value) => value === null ? undefined : value,
  z.number().finite().optional(),
);

const marketStatsSchema = z.object({
  priceChange: optionalNumber,
  liquidityChange: optionalNumber,
  volumeChange: optionalNumber,
  buyVolume: optionalNumber,
  sellVolume: optionalNumber,
  buyOrganicVolume: optionalNumber,
  sellOrganicVolume: optionalNumber,
  numBuys: optionalNumber,
  numSells: optionalNumber,
  numTraders: optionalNumber,
  numOrganicBuyers: optionalNumber,
  numNetBuyers: optionalNumber,
});

const tokenInformationSchema = z.object({
  id: z.string().min(32).max(64),
  name: z.string().min(1).max(128),
  symbol: z.string().min(1).max(32),
  icon: z.string().max(2_048).optional(),
  decimals: z.number().int().min(0).max(18),
  firstPool: z.object({
    id: z.string().min(20).max(128),
    createdAt: z.string().min(10).max(64),
  }).optional(),
  holderCount: optionalNumber,
  organicScore: optionalNumber,
  organicScoreLabel: z.string().max(32).optional(),
  isVerified: z.boolean().optional(),
  fdv: optionalNumber,
  mcap: optionalNumber,
  usdPrice: optionalNumber,
  liquidity: optionalNumber,
  stats5m: marketStatsSchema.optional(),
  stats1h: marketStatsSchema.optional(),
  updatedAt: z.string().max(64).optional(),
});

export type MarketStats = z.infer<typeof marketStatsSchema>;
export type TokenInformation = z.infer<typeof tokenInformationSchema>;

export function parseTokenInformationList(value: unknown): readonly TokenInformation[] {
  const payload = z.array(z.unknown()).max(500).safeParse(value);
  if (!payload.success) throw new Error("Jupiter Tokens API returned an invalid token payload.");
  const tokens = payload.data.flatMap((candidate) => {
    const parsed = tokenInformationSchema.safeParse(candidate);
    return parsed.success ? [Object.freeze(parsed.data)] : [];
  });
  if (payload.data.length > 0 && tokens.length === 0) throw new Error("Jupiter Tokens API did not return any valid tokens.");
  return Object.freeze(tokens);
}

async function tokenApi(path: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<readonly TokenInformation[]> {
  const request = async (url: string) => {
    const response = await fetcher(url, {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) throw new Error(`Jupiter Tokens API returned HTTP ${response.status}.`);
    return parseTokenInformationList(await response.json());
  };
  if (path !== "/recent" || !import.meta.env.PROD) return request(`${JUPITER_TOKENS_API}${path}`);
  try {
    return await request("/api/market/recent");
  } catch (proxyError) {
    if (signal?.aborted) throw proxyError;
    return request(`${JUPITER_TOKENS_API}${path}`);
  }
}

export function fetchRecentTokens(signal?: AbortSignal, fetcher?: typeof fetch): Promise<readonly TokenInformation[]> {
  return tokenApi("/recent", signal, fetcher);
}

export function searchTokenInformation(query: string, signal?: AbortSignal, fetcher?: typeof fetch): Promise<readonly TokenInformation[]> {
  const normalized = query.trim();
  if (!normalized || normalized.length > 128) throw new Error("Token search query is invalid.");
  return tokenApi(`/search?query=${encodeURIComponent(normalized)}`, signal, fetcher);
}

export function safeTokenIcon(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export interface PumpTrade {
  readonly signature: string;
  readonly slot: number;
  readonly mint: string;
  readonly user: string;
  readonly side: "buy" | "sell";
  readonly timestamp: number;
  readonly solAmountLamports: bigint;
  readonly tokenAmountAtomic: bigint;
  readonly feeLamports: bigint;
  readonly creatorFeeLamports: bigint;
  readonly feeBasisPoints: number;
  readonly creatorFeeBasisPoints: number;
  readonly priceSol: number;
}

function recordValue(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}

function integer(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return BigInt(value);
  if (value && typeof value === "object" && "toString" in value && typeof value.toString === "function") {
    const result = String((value as { toString(): string }).toString());
    if (/^-?[0-9]+$/.test(result)) return BigInt(result);
  }
  throw new Error(`Pump event ${field} is not an integer.`);
}

function publicKey(value: unknown, field: string): string {
  if (typeof value === "string" && value.length >= 32) return value;
  if (value && typeof value === "object" && "toBase58" in value && typeof value.toBase58 === "function") {
    const result = String((value as { toBase58(): string }).toBase58());
    if (result.length >= 32) return result;
  }
  throw new Error(`Pump event ${field} is not a public key.`);
}

export function normalizePumpTradeEvent(
  value: unknown,
  context: { readonly signature: string; readonly slot: number; readonly decimals: number },
): PumpTrade {
  if (!value || typeof value !== "object") throw new Error("Pump trade event is not an object.");
  const event = value as Record<string, unknown>;
  const solAmountLamports = integer(recordValue(event, "solAmount", "sol_amount"), "solAmount");
  const tokenAmountAtomic = integer(recordValue(event, "tokenAmount", "token_amount"), "tokenAmount");
  const timestampSeconds = integer(event.timestamp, "timestamp");
  const isBuy = Boolean(recordValue(event, "isBuy", "is_buy"));
  const tokenAmount = Number(tokenAmountAtomic) / 10 ** context.decimals;
  const solAmount = Number(solAmountLamports) / 1_000_000_000;
  return Object.freeze({
    signature: context.signature,
    slot: context.slot,
    mint: publicKey(event.mint, "mint"),
    user: publicKey(event.user, "user"),
    side: isBuy ? "buy" : "sell",
    timestamp: Number(timestampSeconds) * 1_000,
    solAmountLamports,
    tokenAmountAtomic,
    feeLamports: integer(event.fee ?? 0, "fee"),
    creatorFeeLamports: integer(recordValue(event, "creatorFee", "creator_fee") ?? 0, "creatorFee"),
    feeBasisPoints: Number(integer(recordValue(event, "feeBasisPoints", "fee_basis_points") ?? 0, "feeBasisPoints")),
    creatorFeeBasisPoints: Number(integer(recordValue(event, "creatorFeeBasisPoints", "creator_fee_basis_points") ?? 0, "creatorFeeBasisPoints")),
    priceSol: tokenAmount > 0 ? solAmount / tokenAmount : 0,
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function decodePumpTradeLog(
  log: string,
  context: { readonly signature: string; readonly slot: number; readonly decimals: number },
): PumpTrade | undefined {
  if (!log.startsWith("Program data: ")) return undefined;
  let data: Uint8Array;
  try {
    data = Uint8Array.from(getBase64Codec().encode(log.slice("Program data: ".length) as Base64EncodedBytes));
  } catch {
    return undefined;
  }
  if (data.length < 225 || !bytesEqual(data.slice(0, 8), TRADE_EVENT_DISCRIMINATOR)) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let cursor = 8;
  const key = () => {
    const value = getBase58Decoder().decode(data.slice(cursor, cursor + 32));
    cursor += 32;
    return value;
  };
  const u64 = () => {
    const value = view.getBigUint64(cursor, true);
    cursor += 8;
    return value;
  };
  const i64 = () => {
    const value = view.getBigInt64(cursor, true);
    cursor += 8;
    return value;
  };
  const mint = key();
  const solAmount = u64();
  const tokenAmount = u64();
  const isBuy = view.getUint8(cursor) === 1;
  cursor += 1;
  const user = key();
  const timestamp = i64();
  u64(); // virtual_sol_reserves
  u64(); // virtual_token_reserves
  u64(); // real_sol_reserves
  u64(); // real_token_reserves
  key(); // fee_recipient
  const feeBasisPoints = u64();
  const fee = u64();
  key(); // creator
  const creatorFeeBasisPoints = u64();
  const creatorFee = u64();
  return normalizePumpTradeEvent({ mint, solAmount, tokenAmount, isBuy, user, timestamp, feeBasisPoints, fee, creatorFeeBasisPoints, creatorFee }, context);
}

const logsNotificationSchema = z.object({
  method: z.literal("logsNotification"),
  params: z.object({
    result: z.object({
      context: z.object({ slot: z.number().int().nonnegative() }),
      value: z.object({
        signature: z.string().min(64).max(128),
        err: z.unknown().optional(),
        logs: z.array(z.string().max(16_384)).max(4_096),
      }),
    }),
  }),
});

export async function subscribePumpTrades(input: {
  readonly mint: string;
  readonly decimals: number;
  readonly websocketUrl: string;
  readonly onTrade: (trade: PumpTrade) => void;
  readonly onDisconnect?: () => void;
}): Promise<() => Promise<void>> {
  const socket = new WebSocket(input.websocketUrl);
  const requestId = Math.floor(Math.random() * 1_000_000_000) + 1;
  let subscriptionId: number | undefined;
  let intentionalClose = false;
  let disconnectReported = false;
  const reportDisconnect = () => {
    if (!intentionalClose && !disconnectReported) {
      disconnectReported = true;
      input.onDisconnect?.();
    }
  };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("Pump logs WebSocket subscription timed out."));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "logsSubscribe",
      // Pump TradeEvent logs do not reliably include the mint in the outer
      // transaction account list. Subscribe to the official program, then
      // apply the decoded mint filter below.
      params: [{ mentions: [PUMP_PROGRAM_ADDRESS] }, { commitment: "confirmed" }],
    }));
    socket.onmessage = (message) => {
      let payload: unknown;
      try { payload = JSON.parse(String(message.data)); } catch { return; }
      if (payload && typeof payload === "object" && "id" in payload && payload.id === requestId) {
        const result = "result" in payload ? payload.result : undefined;
        if (typeof result !== "number") {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error("Pump logs WebSocket rejected the subscription."));
          }
          return;
        }
        subscriptionId = result;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
        return;
      }
      const notification = logsNotificationSchema.safeParse(payload);
      if (!notification.success) return;
      const { context, value } = notification.data.params.result;
      if (value.err) return;
      for (const log of value.logs) {
        try {
          const trade = decodePumpTradeLog(log, { signature: value.signature, slot: context.slot, decimals: input.decimals });
          if (trade?.mint === input.mint) input.onTrade(trade);
        } catch {
          // Ignore non-trade or version-skewed events; the aggregate token API remains live.
        }
      }
    };
    socket.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Pump logs WebSocket connection failed."));
      } else reportDisconnect();
    };
    socket.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Pump logs WebSocket closed before subscribing."));
      } else reportDisconnect();
    };
  });
  return async () => {
    intentionalClose = true;
    if (socket.readyState === WebSocket.OPEN && subscriptionId !== undefined) {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId + 1, method: "logsUnsubscribe", params: [subscriptionId] }));
    }
    socket.close();
  };
}
