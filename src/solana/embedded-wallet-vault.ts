import type { WalletSession } from "@solana/client";
import {
  address,
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  signTransaction as signKitTransaction,
  type SendableTransaction,
  type Transaction,
} from "@solana/kit";
import { Keypair } from "@solana/web3.js";

const DATABASE_NAME = "sunder-solana-embedded-vault";
const STORE_NAME = "vault";
const DEVICE_KEY_ID = "device-key:v1";
const MAX_WALLETS = 50;
const textEncoder = new TextEncoder();

interface StoredDeviceKey {
  readonly id: typeof DEVICE_KEY_ID;
  readonly kind: "device-key";
  readonly key: CryptoKey;
}

interface StoredEmbeddedWallet {
  readonly id: string;
  readonly kind: "wallet";
  readonly version: 1;
  readonly label: string;
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly createdAt: number;
  readonly iv: Uint8Array;
  readonly ciphertext: ArrayBuffer;
}

export interface EmbeddedWalletMetadata {
  readonly id: string;
  readonly label: string;
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly createdAt: number;
}

let databasePromise: Promise<IDBDatabase> | undefined;
let deviceKeyPromise: Promise<CryptoKey> | undefined;
let creationQueue: Promise<void> = Promise.resolve();

function assertBrowserVaultAvailable(): void {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle || !globalThis.indexedDB) {
    throw new Error("The encrypted wallet vault requires a secure HTTPS browser with Web Crypto and IndexedDB enabled.");
  }
}

function openDatabase(): Promise<IDBDatabase> {
  assertBrowserVaultAvailable();
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open the encrypted wallet vault."));
    request.onblocked = () => reject(new Error("The encrypted wallet vault is blocked by another browser tab."));
  });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The encrypted wallet vault request failed."));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("The encrypted wallet vault transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("The encrypted wallet vault transaction failed."));
  });
}

async function readStored<T>(id: string): Promise<T | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  return requestResult(transaction.objectStore(STORE_NAME).get(id) as IDBRequest<T | undefined>);
}

async function writeStored(value: StoredDeviceKey | StoredEmbeddedWallet): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const completed = transactionCompletion(transaction);
  try {
    transaction.objectStore(STORE_NAME).put(value);
  } catch (error) {
    transaction.abort();
    await completed.catch(() => undefined);
    throw error;
  }
  await completed;
}

async function deleteStored(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const completed = transactionCompletion(transaction);
  try {
    transaction.objectStore(STORE_NAME).delete(id);
  } catch (error) {
    transaction.abort();
    await completed.catch(() => undefined);
    throw error;
  }
  await completed;
}

async function readAllStored(): Promise<readonly unknown[]> {
  const database = await openDatabase();
  return requestResult(database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll());
}

function isDeviceKey(value: unknown): value is StoredDeviceKey {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredDeviceKey>;
  return candidate.id === DEVICE_KEY_ID && candidate.kind === "device-key" && Boolean(candidate.key) && candidate.key?.type === "secret";
}

function exactBytes(value: unknown, length: number): Uint8Array | undefined {
  if (!ArrayBuffer.isView(value) || value.byteLength !== length) return undefined;
  return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

function ownedArrayBuffer(value: unknown): ArrayBuffer | undefined {
  if (Object.prototype.toString.call(value) !== "[object ArrayBuffer]") return undefined;
  return Uint8Array.from(new Uint8Array(value as ArrayBuffer)).buffer;
}

function parseStoredWallet(value: unknown): StoredEmbeddedWallet | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<StoredEmbeddedWallet>;
  if (candidate.kind !== "wallet" || candidate.version !== 1 || typeof candidate.id !== "string" || !candidate.id.startsWith("embedded:")) return undefined;
  if (typeof candidate.label !== "string" || candidate.label.length < 1 || candidate.label.length > 80) return undefined;
  if (typeof candidate.address !== "string" || candidate.address.length < 32 || candidate.address.length > 64) return undefined;
  const publicKey = exactBytes(candidate.publicKey, 32);
  const iv = exactBytes(candidate.iv, 12);
  const ciphertext = ownedArrayBuffer(candidate.ciphertext);
  if (!publicKey || !iv || !ciphertext) return undefined;
  if (typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt)) return undefined;
  try { address(candidate.address); } catch { return undefined; }
  return Object.freeze({ ...candidate, publicKey, iv, ciphertext }) as StoredEmbeddedWallet;
}

function metadata(record: StoredEmbeddedWallet): EmbeddedWalletMetadata {
  return Object.freeze({ id: record.id, label: record.label, address: record.address, publicKey: Uint8Array.from(record.publicKey), createdAt: record.createdAt });
}

async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  if (!deviceKeyPromise) deviceKeyPromise = (async () => {
    const stored = await readStored<unknown>(DEVICE_KEY_ID);
    if (isDeviceKey(stored)) return stored.key;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await writeStored(Object.freeze({ id: DEVICE_KEY_ID, kind: "device-key", key }));
    return key;
  })().catch((error) => {
    deviceKeyPromise = undefined;
    throw error;
  });
  return deviceKeyPromise;
}

function additionalData(record: Pick<StoredEmbeddedWallet, "id" | "address">): Uint8Array<ArrayBuffer> {
  return new Uint8Array(textEncoder.encode(`sunder|solana|embedded|v1|${record.id}|${record.address}`));
}

async function decryptSecret(record: StoredEmbeddedWallet): Promise<Uint8Array> {
  const key = await getOrCreateDeviceKey();
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(record.iv), additionalData: additionalData(record) }, key, record.ciphertext);
  } catch {
    throw new Error("This wallet cannot be unlocked in the current browser profile. Restore it from an exported private key in a trusted wallet.");
  }
  const secret = new Uint8Array(plaintext);
  if (secret.length !== 64) {
    secret.fill(0);
    throw new Error("The encrypted wallet record is invalid.");
  }
  return secret;
}

async function storedWallet(id: string): Promise<StoredEmbeddedWallet> {
  const record = parseStoredWallet(await readStored<unknown>(id));
  if (!record) throw new Error("The embedded wallet no longer exists in this browser profile.");
  return record;
}

export async function listEmbeddedWallets(): Promise<readonly EmbeddedWalletMetadata[]> {
  const values = await readAllStored();
  return Object.freeze(values.flatMap((value) => {
    const record = parseStoredWallet(value);
    return record ? [metadata(record)] : [];
  }).sort((left, right) => left.createdAt - right.createdAt));
}

async function createEmbeddedWalletNow(): Promise<EmbeddedWalletMetadata> {
  const existing = await listEmbeddedWallets();
  if (existing.length >= MAX_WALLETS) throw new Error(`This browser vault is limited to ${MAX_WALLETS} embedded wallets.`);
  const keyPair = Keypair.generate();
  const secret = Uint8Array.from(keyPair.secretKey);
  const id = `embedded:${crypto.randomUUID()}`;
  const nextLabelNumber = Math.max(0, ...existing.map((wallet) => Number(/^Sunder Wallet ([0-9]+)$/.exec(wallet.label)?.[1] ?? 0))) + 1;
  const label = `Sunder Wallet ${nextLabelNumber}`;
  const walletAddress = keyPair.publicKey.toBase58();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const key = await getOrCreateDeviceKey();
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData({ id, address: walletAddress }) }, key, secret);
    const record: StoredEmbeddedWallet = Object.freeze({
      id,
      kind: "wallet",
      version: 1,
      label,
      address: walletAddress,
      publicKey: keyPair.publicKey.toBytes(),
      createdAt: Date.now(),
      iv,
      ciphertext,
    });
    await writeStored(record);
    return metadata(record);
  } finally {
    secret.fill(0);
  }
}

export function createEmbeddedWallet(): Promise<EmbeddedWalletMetadata> {
  const result = creationQueue.then(createEmbeddedWalletNow);
  creationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function deleteEmbeddedWallet(id: string): Promise<void> {
  if (!id.startsWith("embedded:")) throw new Error("Only an embedded wallet can be removed from this vault.");
  await deleteStored(id);
}

export async function exportEmbeddedWalletPrivateKey(id: string): Promise<string> {
  const record = await storedWallet(id);
  const secret = await decryptSecret(record);
  try {
    const signer = await createKeyPairSignerFromBytes(secret, false);
    if (signer.address.toString() !== record.address) throw new Error("The encrypted wallet address does not match its private key.");
    return getBase58Decoder().decode(secret);
  } finally {
    secret.fill(0);
  }
}

export function createEmbeddedWalletSession(wallet: EmbeddedWalletMetadata): WalletSession {
  const accountAddress = address(wallet.address);
  return Object.freeze({
    account: Object.freeze({ address: accountAddress, publicKey: Uint8Array.from(wallet.publicKey), label: wallet.label }),
    connector: Object.freeze({ id: wallet.id, name: wallet.label, kind: "embedded", ready: true, canAutoConnect: true }),
    disconnect: async () => undefined,
    signTransaction: async (transaction: SendableTransaction & Transaction) => {
      const record = await storedWallet(wallet.id);
      const secret = await decryptSecret(record);
      try {
        const signer = await createKeyPairSignerFromBytes(secret, false);
        if (signer.address.toString() !== wallet.address) throw new Error("The encrypted wallet address does not match its private key.");
        return await signKitTransaction([signer.keyPair], transaction);
      } finally {
        secret.fill(0);
      }
    },
  });
}
