import { z } from "zod";

// The key-backed api.jup.ag gateway rejects anonymous browser traffic. Jupiter's
// public-lite host serves the same Tokens V2 schema and keeps the read-only
// discovery/search path usable without ever shipping an API key to the client.
export const JUPITER_TOKENS_API = "https://lite-api.jup.ag/tokens/v2";
export const PUMP_PROGRAM_ADDRESS = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM_ADDRESS = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const TRADE_EVENT_DISCRIMINATOR = Uint8Array.from([189, 219, 127, 211, 78, 230, 97, 238]);
const AMM_BUY_EVENT_DISCRIMINATOR = Uint8Array.from([103, 244, 82, 31, 44, 245, 119, 119]);
const AMM_SELL_EVENT_DISCRIMINATOR = Uint8Array.from([62, 47, 55, 10, 165, 3, 220, 42]);
const AMM_POOL_ACCOUNT_DISCRIMINATOR = Uint8Array.from([241, 154, 109, 4, 17, 177, 109, 188]);
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase64Bytes(value: string): Uint8Array {
  return Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0));
}

function encodeBase58Bytes(value: Uint8Array): string {
  let integer = 0n;
  for (const byte of value) integer = (integer << 8n) | BigInt(byte);
  let encoded = "";
  while (integer > 0n) {
    encoded = BASE58_ALPHABET[Number(integer % 58n)] + encoded;
    integer /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === 0) leadingZeroes += 1;
  return "1".repeat(leadingZeroes) + encoded;
}

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
  circSupply: optionalNumber,
  totalSupply: optionalNumber,
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
  /** Zero-based position of the TradeEvent inside the confirmed transaction logs. */
  readonly eventIndex: number;
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
  readonly virtualSolReservesLamports: bigint;
  readonly virtualTokenReservesAtomic: bigint;
  readonly priceSol: number;
}

export interface PumpAmmPoolMints {
  readonly baseMint: string;
  readonly quoteMint: string;
}

const pumpTradeWireSchema = z.object({
  signature: z.string().min(64).max(128),
  eventIndex: z.number().int().nonnegative(),
  slot: z.number().int().nonnegative(),
  mint: z.string().min(32).max(64),
  user: z.string().min(32).max(64),
  side: z.enum(["buy", "sell"]),
  timestamp: z.number().int().nonnegative(),
  solAmountLamports: z.string().regex(/^[0-9]+$/),
  tokenAmountAtomic: z.string().regex(/^[0-9]+$/),
  feeLamports: z.string().regex(/^[0-9]+$/),
  creatorFeeLamports: z.string().regex(/^[0-9]+$/),
  feeBasisPoints: z.number().int().nonnegative(),
  creatorFeeBasisPoints: z.number().int().nonnegative(),
  virtualSolReservesLamports: z.string().regex(/^[0-9]+$/),
  virtualTokenReservesAtomic: z.string().regex(/^[0-9]+$/),
  priceSol: z.number().finite().positive(),
});

export function serializePumpTradeHistory(trades: readonly PumpTrade[]): string {
  return JSON.stringify(trades.slice(0, 160), (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}

export function parsePumpTradeHistory(value: unknown): readonly PumpTrade[] {
  const parsed = z.array(pumpTradeWireSchema).max(160).parse(value);
  return Object.freeze(parsed.map((trade) => Object.freeze({
    ...trade,
    solAmountLamports: BigInt(trade.solAmountLamports),
    tokenAmountAtomic: BigInt(trade.tokenAmountAtomic),
    feeLamports: BigInt(trade.feeLamports),
    creatorFeeLamports: BigInt(trade.creatorFeeLamports),
    virtualSolReservesLamports: BigInt(trade.virtualSolReservesLamports),
    virtualTokenReservesAtomic: BigInt(trade.virtualTokenReservesAtomic),
  })));
}

function pumpTradeKey(trade: Pick<PumpTrade, "signature" | "eventIndex">): string {
  return `${trade.signature}:${trade.eventIndex}`;
}

function comparePumpTradesDescending(left: PumpTrade, right: PumpTrade): number {
  return right.slot - left.slot
    || right.eventIndex - left.eventIndex
    || right.timestamp - left.timestamp
    || right.signature.localeCompare(left.signature);
}

export function mergeConfirmedPumpTrade(current: readonly PumpTrade[], trade: PumpTrade): readonly PumpTrade[] {
  const newest = current[0];
  if (newest && (trade.slot < newest.slot || (trade.slot === newest.slot && trade.eventIndex < newest.eventIndex))) return current;
  const key = pumpTradeKey(trade);
  return Object.freeze([trade, ...current.filter((item) => pumpTradeKey(item) !== key)]
    .sort(comparePumpTradesDescending)
    .slice(0, 160));
}

export function mergePumpTradeHistory(current: readonly PumpTrade[], history: readonly PumpTrade[]): readonly PumpTrade[] {
  const byEvent = new Map<string, PumpTrade>();
  for (const trade of [...current, ...history]) byEvent.set(pumpTradeKey(trade), trade);
  return Object.freeze([...byEvent.values()]
    .sort(comparePumpTradesDescending)
    .slice(0, 160));
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
  context: { readonly signature: string; readonly eventIndex?: number; readonly slot: number; readonly decimals: number },
): PumpTrade {
  if (!value || typeof value !== "object") throw new Error("Pump trade event is not an object.");
  const event = value as Record<string, unknown>;
  const solAmountLamports = integer(recordValue(event, "solAmount", "sol_amount"), "solAmount");
  const tokenAmountAtomic = integer(recordValue(event, "tokenAmount", "token_amount"), "tokenAmount");
  const virtualSolReservesLamports = integer(recordValue(event, "virtualSolReserves", "virtual_sol_reserves") ?? 0, "virtualSolReserves");
  const virtualTokenReservesAtomic = integer(recordValue(event, "virtualTokenReserves", "virtual_token_reserves") ?? 0, "virtualTokenReserves");
  const timestampSeconds = integer(event.timestamp, "timestamp");
  const isBuy = Boolean(recordValue(event, "isBuy", "is_buy"));
  const tokenAmount = Number(tokenAmountAtomic) / 10 ** context.decimals;
  const solAmount = Number(solAmountLamports) / 1_000_000_000;
  const virtualTokenReserves = Number(virtualTokenReservesAtomic) / 10 ** context.decimals;
  const virtualSolReserves = Number(virtualSolReservesLamports) / 1_000_000_000;
  // Execution amount / tokens is an average fill price and visibly distorts
  // large candles. Pump's confirmed TradeEvent carries the post-trade spot
  // state in its virtual reserves, so prefer that canonical ratio.
  const reserveSpotPrice = virtualTokenReserves > 0 ? virtualSolReserves / virtualTokenReserves : 0;
  return Object.freeze({
    signature: context.signature,
    eventIndex: context.eventIndex ?? 0,
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
    virtualSolReservesLamports,
    virtualTokenReservesAtomic,
    priceSol: reserveSpotPrice > 0 ? reserveSpotPrice : tokenAmount > 0 ? solAmount / tokenAmount : 0,
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function decodePumpTradeLog(
  log: string,
  context: { readonly signature: string; readonly eventIndex?: number; readonly slot: number; readonly decimals: number },
): PumpTrade | undefined {
  if (!log.startsWith("Program data: ")) return undefined;
  let data: Uint8Array;
  try {
    data = decodeBase64Bytes(log.slice("Program data: ".length));
  } catch {
    return undefined;
  }
  if (data.length < 225 || !bytesEqual(data.slice(0, 8), TRADE_EVENT_DISCRIMINATOR)) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let cursor = 8;
  const key = () => {
    const value = encodeBase58Bytes(data.slice(cursor, cursor + 32));
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
  const virtualSolReserves = u64();
  const virtualTokenReserves = u64();
  u64(); // real_sol_reserves
  u64(); // real_token_reserves
  key(); // fee_recipient
  const feeBasisPoints = u64();
  const fee = u64();
  key(); // creator
  const creatorFeeBasisPoints = u64();
  const creatorFee = u64();
  return normalizePumpTradeEvent({ mint, solAmount, tokenAmount, isBuy, user, timestamp, virtualSolReserves, virtualTokenReserves, feeBasisPoints, fee, creatorFeeBasisPoints, creatorFee }, context);
}

interface RawPumpAmmTradeEvent {
  readonly isBuy: boolean;
  readonly timestamp: bigint;
  readonly baseAmount: bigint;
  readonly quoteAmount: bigint;
  readonly poolBaseTokenReserves: bigint;
  readonly poolQuoteTokenReserves: bigint;
  readonly lpFeeBasisPoints: bigint;
  readonly lpFee: bigint;
  readonly protocolFeeBasisPoints: bigint;
  readonly protocolFee: bigint;
  readonly pool: string;
  readonly user: string;
  readonly creatorFeeBasisPoints: bigint;
  readonly creatorFee: bigint;
}

function parsePumpAmmTradeLog(log: string): RawPumpAmmTradeEvent | undefined {
  if (!log.startsWith("Program data: ")) return undefined;
  let data: Uint8Array;
  try {
    data = decodeBase64Bytes(log.slice("Program data: ".length));
  } catch {
    return undefined;
  }
  const isBuy = bytesEqual(data.slice(0, 8), AMM_BUY_EVENT_DISCRIMINATOR);
  const isSell = bytesEqual(data.slice(0, 8), AMM_SELL_EVENT_DISCRIMINATOR);
  // Both official Pump AMM events share this stable prefix through the coin
  // creator fee. Later event extensions are deliberately ignored.
  if (data.length < 360 || (!isBuy && !isSell)) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let cursor = 8;
  const key = () => {
    const value = encodeBase58Bytes(data.slice(cursor, cursor + 32));
    cursor += 32;
    return value;
  };
  const u64 = () => {
    const value = view.getBigUint64(cursor, true);
    cursor += 8;
    return value;
  };
  const timestamp = view.getBigInt64(cursor, true);
  cursor += 8;
  const baseAmount = u64(); // base_amount_out (buy) or base_amount_in (sell)
  u64(); // max_quote_amount_in or min_quote_amount_out
  u64(); // user_base_token_reserves
  u64(); // user_quote_token_reserves
  const poolBaseTokenReserves = u64();
  const poolQuoteTokenReserves = u64();
  const quoteAmount = u64(); // quote_amount_in or quote_amount_out
  const lpFeeBasisPoints = u64();
  const lpFee = u64();
  const protocolFeeBasisPoints = u64();
  const protocolFee = u64();
  u64(); // quote amount with/without LP fee
  u64(); // exact user quote amount
  const pool = key();
  const user = key();
  key(); // user_base_token_account
  key(); // user_quote_token_account
  key(); // protocol_fee_recipient
  key(); // protocol_fee_recipient_token_account
  key(); // coin_creator
  const creatorFeeBasisPoints = u64();
  const creatorFee = u64();
  return Object.freeze({ isBuy, timestamp, baseAmount, quoteAmount, poolBaseTokenReserves, poolQuoteTokenReserves, lpFeeBasisPoints, lpFee, protocolFeeBasisPoints, protocolFee, pool, user, creatorFeeBasisPoints, creatorFee });
}

export function decodePumpAmmPoolAddress(log: string): string | undefined {
  return parsePumpAmmTradeLog(log)?.pool;
}

export function decodePumpAmmPoolMints(data: Uint8Array): PumpAmmPoolMints | undefined {
  // Pool account layout: discriminator + bump + index + creator + base mint + quote mint.
  if (data.length < 107 || !bytesEqual(data.slice(0, 8), AMM_POOL_ACCOUNT_DISCRIMINATOR)) return undefined;
  return Object.freeze({
    baseMint: encodeBase58Bytes(data.slice(43, 75)),
    quoteMint: encodeBase58Bytes(data.slice(75, 107)),
  });
}

export function decodePumpAmmTradeLog(
  log: string,
  context: { readonly signature: string; readonly eventIndex?: number; readonly slot: number; readonly decimals: number; readonly mint: string; readonly poolMints: PumpAmmPoolMints },
): PumpTrade | undefined {
  const event = parsePumpAmmTradeLog(log);
  if (!event) return undefined;
  const targetIsBase = context.poolMints.baseMint === context.mint && context.poolMints.quoteMint === WRAPPED_SOL_MINT;
  const targetIsQuote = context.poolMints.quoteMint === context.mint && context.poolMints.baseMint === WRAPPED_SOL_MINT;
  // Pump AMM supports either mint order. An event only says base/quote; treating
  // quote as SOL unconditionally turns reverse pools into impossible price
  // wicks. Non-SOL pairs cannot populate a SOL-denominated chart at all.
  if (!targetIsBase && !targetIsQuote) return undefined;
  const solAmount = targetIsBase ? event.quoteAmount : event.baseAmount;
  const tokenAmount = targetIsBase ? event.baseAmount : event.quoteAmount;
  const virtualSolReserves = targetIsBase ? event.poolQuoteTokenReserves : event.poolBaseTokenReserves;
  const virtualTokenReserves = targetIsBase ? event.poolBaseTokenReserves : event.poolQuoteTokenReserves;
  const isTokenBuy = targetIsBase ? event.isBuy : !event.isBuy;
  // AMM fees are denominated in the quote mint. Preserve exact lamports only
  // when quote is wSOL; the BPS fields remain valid for either orientation.
  const fee = targetIsBase ? event.lpFee + event.protocolFee : 0n;
  const creatorFee = targetIsBase ? event.creatorFee : 0n;
  return normalizePumpTradeEvent({
    mint: context.mint,
    user: event.user,
    solAmount,
    tokenAmount,
    isBuy: isTokenBuy,
    timestamp: event.timestamp,
    virtualSolReserves,
    virtualTokenReserves,
    feeBasisPoints: event.lpFeeBasisPoints + event.protocolFeeBasisPoints,
    fee,
    creatorFeeBasisPoints: event.creatorFeeBasisPoints,
    creatorFee,
  }, context);
}

const signatureHistorySchema = z.object({
  result: z.array(z.object({ signature: z.string().min(64).max(128), slot: z.number().int().nonnegative(), err: z.unknown().nullable().optional() })).max(160),
  error: z.unknown().optional(),
});

const transactionHistorySchema = z.object({
  result: z.object({
    slot: z.number().int().nonnegative(),
    meta: z.object({ logMessages: z.array(z.string().max(16_384)).max(4_096).nullable() }).nullable(),
  }).nullable(),
  error: z.unknown().optional(),
});

const accountInfoSchema = z.object({
  result: z.object({
    value: z.object({
      owner: z.string().min(32).max(64),
      data: z.tuple([z.string().max(16_384), z.string().max(32)]),
    }).nullable(),
  }),
  error: z.unknown().optional(),
});

async function rpcRequest(
  rpcUrl: string,
  method: string,
  params: readonly unknown[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(rpcUrl, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `${method}:${Math.random().toString(36).slice(2)}`, method, params }),
    signal,
  });
  if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}.`);
  return response.json();
}

async function fetchPumpAmmPoolMints(input: {
  readonly pool: string;
  readonly rpcUrl: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}): Promise<PumpAmmPoolMints | undefined> {
  const payload = accountInfoSchema.parse(await rpcRequest(
    input.rpcUrl,
    "getAccountInfo",
    [input.pool, { commitment: "confirmed", encoding: "base64" }],
    input.signal,
    input.fetcher,
  ));
  if (payload.error || !payload.result.value || payload.result.value.owner !== PUMP_AMM_PROGRAM_ADDRESS || payload.result.value.data[1] !== "base64") return undefined;
  try {
    return decodePumpAmmPoolMints(decodeBase64Bytes(payload.result.value.data[0]));
  } catch {
    return undefined;
  }
}

export async function fetchPumpTradeHistory(input: {
  readonly mint: string;
  readonly decimals: number;
  readonly rpcUrl: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}): Promise<readonly PumpTrade[]> {
  const limit = Math.min(120, Math.max(1, input.limit ?? 72));
  const signaturesPayload = signatureHistorySchema.parse(await rpcRequest(
    input.rpcUrl,
    "getSignaturesForAddress",
    [input.mint, { commitment: "confirmed", limit }],
    input.signal,
    input.fetcher,
  ));
  if (signaturesPayload.error) throw new Error("Solana RPC rejected Pump signature history.");
  const signatures = signaturesPayload.result.filter((entry) => entry.err === null || entry.err === undefined);
  const trades: PumpTrade[] = [];
  const poolMintLookups = new Map<string, Promise<PumpAmmPoolMints | undefined>>();
  const resolvePoolMints = (pool: string) => {
    const cached = poolMintLookups.get(pool);
    if (cached) return cached;
    const lookup = fetchPumpAmmPoolMints({ pool, rpcUrl: input.rpcUrl, signal: input.signal, fetcher: input.fetcher });
    poolMintLookups.set(pool, lookup);
    return lookup;
  };
  let resolvedTransactions = 0;
  const concurrency = 12;
  for (let offset = 0; offset < signatures.length; offset += concurrency) {
    const chunk = signatures.slice(offset, offset + concurrency);
    const responses = await Promise.allSettled(chunk.map(async (entry) => {
      const parsed = transactionHistorySchema.parse(await rpcRequest(
        input.rpcUrl,
        "getTransaction",
        [entry.signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }],
        input.signal,
        input.fetcher,
      ));
      if (parsed.error) throw new Error("Solana RPC rejected a Pump transaction lookup.");
      if (!parsed.result?.meta?.logMessages) {
        resolvedTransactions += 1;
        return [];
      }
      const decoded: PumpTrade[] = [];
      for (const [eventIndex, log] of parsed.result.meta.logMessages.entries()) {
        const context = { signature: entry.signature, eventIndex, slot: parsed.result.slot, decimals: input.decimals } as const;
        try {
          const pumpTrade = decodePumpTradeLog(log, context);
          if (pumpTrade?.mint === input.mint) {
            decoded.push(pumpTrade);
            continue;
          }
        } catch {
          // Ignore a malformed bonding-curve event without inventing a candle.
        }
        const pool = decodePumpAmmPoolAddress(log);
        if (!pool) continue;
        // Provider failures must reject this transaction lookup so the API can
        // try its secondary RPC instead of caching a misleading empty chart.
        const poolMints = await resolvePoolMints(pool);
        if (!poolMints) continue;
        try {
          const ammTrade = decodePumpAmmTradeLog(log, { ...context, mint: input.mint, poolMints });
          if (ammTrade?.mint === input.mint) decoded.push(ammTrade);
        } catch {
          // Ignore non-SOL-paired or version-skewed AMM event data.
        }
      }
      resolvedTransactions += 1;
      return decoded;
    }));
    for (const response of responses) {
      if (response.status === "fulfilled") trades.push(...response.value);
    }
  }
  if (signatures.length > 0 && resolvedTransactions < Math.ceil(signatures.length * 0.8)) {
    throw new Error("Solana RPC returned incomplete Pump transaction history.");
  }
  return mergePumpTradeHistory([], trades);
}

export async function fetchPumpTradeHistoryFromApi(input: {
  readonly mint: string;
  readonly decimals: number;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}): Promise<readonly PumpTrade[]> {
  const response = await (input.fetcher ?? fetch)(`/api/market/pump-history?mint=${encodeURIComponent(input.mint)}&decimals=${input.decimals}`, {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`Pump history API returned HTTP ${response.status}.`);
  return parsePumpTradeHistory(await response.json());
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
  readonly rpcUrl: string;
  readonly websocketUrl: string;
  readonly onTrade: (trade: PumpTrade) => void;
  readonly onDisconnect?: () => void;
}): Promise<() => Promise<void>> {
  const socket = new WebSocket(input.websocketUrl);
  const lookupController = new AbortController();
  const poolMintLookups = new Map<string, Promise<PumpAmmPoolMints | undefined>>();
  const resolvePoolMints = (pool: string) => {
    const cached = poolMintLookups.get(pool);
    if (cached) return cached;
    const lookup = fetchPumpAmmPoolMints({
      pool,
      rpcUrl: input.rpcUrl,
      signal: AbortSignal.any([lookupController.signal, AbortSignal.timeout(4_500)]),
    }).catch((error: unknown) => {
      poolMintLookups.delete(pool);
      throw error;
    });
    poolMintLookups.set(pool, lookup);
    return lookup;
  };
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
      // The mint is an account in both current bonding-curve and Pump AMM swap
      // transactions. Filtering it here avoids streaming the entire global
      // Pump firehose into every browser tab.
      params: [{ mentions: [input.mint] }, { commitment: "confirmed" }],
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
      for (const [eventIndex, log] of value.logs.entries()) {
        try {
          const tradeContext = { signature: value.signature, eventIndex, slot: context.slot, decimals: input.decimals } as const;
          const pumpTrade = decodePumpTradeLog(log, tradeContext);
          if (pumpTrade?.mint === input.mint) {
            input.onTrade(pumpTrade);
            continue;
          }
          const pool = decodePumpAmmPoolAddress(log);
          if (!pool) continue;
          void resolvePoolMints(pool).then((poolMints) => {
            if (intentionalClose || !poolMints) return;
            const ammTrade = decodePumpAmmTradeLog(log, { ...tradeContext, mint: input.mint, poolMints });
            if (ammTrade?.mint === input.mint) input.onTrade(ammTrade);
          }).catch(() => {
            // Reconnect through the bounded policy; repeated HTTP lookup
            // failures eventually switch the terminal to confirmed polling.
            if (!intentionalClose) socket.close();
          });
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
      lookupController.abort();
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Pump logs WebSocket closed before subscribing."));
      } else reportDisconnect();
    };
  });
  return async () => {
    intentionalClose = true;
    lookupController.abort();
    if (socket.readyState === WebSocket.OPEN && subscriptionId !== undefined) {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId + 1, method: "logsUnsubscribe", params: [subscriptionId] }));
    }
    socket.close();
  };
}
