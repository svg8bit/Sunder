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
const BACKUP_SCHEMA = "sunder-solana-embedded-vault-backup";
const BACKUP_VERSION = 1;
const BACKUP_KDF_ITERATIONS = 600_000;
const MAX_BACKUP_BYTES = 256_000;
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

interface EncryptedBackupWallet {
  readonly id: string;
  readonly label: string;
  readonly address: string;
  readonly publicKey: string;
  readonly createdAt: number;
  readonly iv: string;
  readonly ciphertext: string;
}

interface EmbeddedWalletBackup {
  readonly schema: typeof BACKUP_SCHEMA;
  readonly version: typeof BACKUP_VERSION;
  readonly createdAt: string;
  readonly kdf: {
    readonly name: "PBKDF2";
    readonly hash: "SHA-256";
    readonly iterations: typeof BACKUP_KDF_ITERATIONS;
    readonly salt: string;
  };
  readonly wallets: readonly EncryptedBackupWallet[];
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

async function writeStoredWallets(values: readonly StoredEmbeddedWallet[]): Promise<void> {
  if (values.length === 0) return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const completed = transactionCompletion(transaction);
  try {
    for (const value of values) transaction.objectStore(STORE_NAME).put(value);
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

function encodeBase64(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: unknown, expectedLength: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("The encrypted wallet backup contains invalid binary data.");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("The encrypted wallet backup contains invalid binary data.");
  }
  if (binary.length !== expectedLength) throw new Error("The encrypted wallet backup contains invalid binary data.");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function validateBackupPassphrase(passphrase: string): void {
  if (passphrase.length < 12 || passphrase.length > 256) throw new Error("Use a backup passphrase between 12 and 256 characters.");
}

async function deriveBackupKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  validateBackupPassphrase(passphrase);
  const material = await crypto.subtle.importKey("raw", textEncoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", iterations: BACKUP_KDF_ITERATIONS, salt },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function backupAdditionalData(record: Pick<EncryptedBackupWallet, "id" | "label" | "address" | "createdAt">): Uint8Array<ArrayBuffer> {
  return new Uint8Array(textEncoder.encode(`sunder|solana|backup|v1|${record.id}|${record.address}|${record.label}|${record.createdAt}`));
}

function parseBackupWallet(value: unknown): EncryptedBackupWallet {
  if (!value || typeof value !== "object") throw new Error("The encrypted wallet backup contains an invalid wallet record.");
  const candidate = value as Partial<EncryptedBackupWallet>;
  if (typeof candidate.id !== "string" || !candidate.id.startsWith("embedded:") || candidate.id.length > 128) throw new Error("The encrypted wallet backup contains an invalid wallet id.");
  if (typeof candidate.label !== "string" || candidate.label.length < 1 || candidate.label.length > 80) throw new Error("The encrypted wallet backup contains an invalid wallet label.");
  if (typeof candidate.address !== "string" || candidate.address.length < 32 || candidate.address.length > 64) throw new Error("The encrypted wallet backup contains an invalid wallet address.");
  try { address(candidate.address); } catch { throw new Error("The encrypted wallet backup contains an invalid wallet address."); }
  if (typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt) || candidate.createdAt <= 0) throw new Error("The encrypted wallet backup contains an invalid creation time.");
  decodeBase64(candidate.publicKey, 32);
  decodeBase64(candidate.iv, 12);
  decodeBase64(candidate.ciphertext, 80);
  return Object.freeze(candidate) as EncryptedBackupWallet;
}

function parseBackup(serialized: string): EmbeddedWalletBackup {
  if (typeof serialized !== "string" || serialized.length === 0 || serialized.length > MAX_BACKUP_BYTES) throw new Error("The encrypted wallet backup file is empty or too large.");
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error("The selected file is not a valid Sunder wallet backup."); }
  if (!value || typeof value !== "object") throw new Error("The selected file is not a valid Sunder wallet backup.");
  const candidate = value as Partial<EmbeddedWalletBackup>;
  if (candidate.schema !== BACKUP_SCHEMA || candidate.version !== BACKUP_VERSION) throw new Error("This wallet backup format is not supported.");
  if (!candidate.kdf || candidate.kdf.name !== "PBKDF2" || candidate.kdf.hash !== "SHA-256" || candidate.kdf.iterations !== BACKUP_KDF_ITERATIONS) throw new Error("This wallet backup uses an unsupported key-derivation policy.");
  decodeBase64(candidate.kdf.salt, 16);
  if (!Array.isArray(candidate.wallets) || candidate.wallets.length < 1 || candidate.wallets.length > MAX_WALLETS) throw new Error("The wallet backup contains an invalid number of wallets.");
  const wallets = candidate.wallets.map(parseBackupWallet);
  if (new Set(wallets.map((wallet) => wallet.id)).size !== wallets.length || new Set(wallets.map((wallet) => wallet.address)).size !== wallets.length) throw new Error("The wallet backup contains duplicate wallet records.");
  return Object.freeze({ ...candidate, wallets }) as EmbeddedWalletBackup;
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

async function decryptSecret(record: StoredEmbeddedWallet): Promise<Uint8Array<ArrayBuffer>> {
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

export async function exportEmbeddedWalletBackup(passphrase: string): Promise<string> {
  validateBackupPassphrase(passphrase);
  const records = (await readAllStored()).flatMap((value) => {
    const record = parseStoredWallet(value);
    return record ? [record] : [];
  }).sort((left, right) => left.createdAt - right.createdAt);
  if (records.length === 0) throw new Error("Create an embedded wallet before exporting a vault backup.");

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveBackupKey(passphrase, salt);
  const wallets: EncryptedBackupWallet[] = [];
  for (const record of records) {
    const secret = await decryptSecret(record);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const backupRecord = Object.freeze({ id: record.id, label: record.label, address: record.address, publicKey: encodeBase64(record.publicKey), createdAt: record.createdAt });
    try {
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: backupAdditionalData(backupRecord) }, key, secret);
      wallets.push(Object.freeze({ ...backupRecord, iv: encodeBase64(iv), ciphertext: encodeBase64(ciphertext) }));
    } finally {
      secret.fill(0);
    }
  }

  const backup: EmbeddedWalletBackup = Object.freeze({
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    kdf: Object.freeze({ name: "PBKDF2", hash: "SHA-256", iterations: BACKUP_KDF_ITERATIONS, salt: encodeBase64(salt) }),
    wallets: Object.freeze(wallets),
  });
  return JSON.stringify(backup, null, 2);
}

export async function restoreEmbeddedWalletBackup(serialized: string, passphrase: string): Promise<readonly EmbeddedWalletMetadata[]> {
  validateBackupPassphrase(passphrase);
  const backup = parseBackup(serialized);
  const salt = decodeBase64(backup.kdf.salt, 16);
  const backupKey = await deriveBackupKey(passphrase, salt);
  const currentRecords = (await readAllStored()).flatMap((value) => {
    const record = parseStoredWallet(value);
    return record ? [record] : [];
  });
  const currentById = new Map(currentRecords.map((record) => [record.id, record]));
  const currentByAddress = new Map(currentRecords.map((record) => [record.address, record]));
  const newAddresses = backup.wallets.filter((wallet) => !currentByAddress.has(wallet.address));
  if (currentRecords.length + newAddresses.length > MAX_WALLETS) throw new Error(`This browser vault is limited to ${MAX_WALLETS} embedded wallets.`);

  const deviceKey = await getOrCreateDeviceKey();
  const restored: StoredEmbeddedWallet[] = [];
  for (const backupRecord of backup.wallets) {
    const idCollision = currentById.get(backupRecord.id);
    if (idCollision && idCollision.address !== backupRecord.address) throw new Error("A different local wallet already uses an id from this backup.");
    const existingAddress = currentByAddress.get(backupRecord.address);
    const targetId = existingAddress?.id ?? backupRecord.id;
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decodeBase64(backupRecord.iv, 12), additionalData: backupAdditionalData(backupRecord) },
        backupKey,
        decodeBase64(backupRecord.ciphertext, 80),
      );
    } catch {
      throw new Error("Unable to decrypt this backup. Check the passphrase and file integrity.");
    }
    const secret = new Uint8Array(plaintext);
    try {
      if (secret.length !== 64) throw new Error("The decrypted wallet backup is invalid.");
      const keyPair = Keypair.fromSecretKey(secret);
      const walletAddress = keyPair.publicKey.toBase58();
      if (walletAddress !== backupRecord.address || encodeBase64(keyPair.publicKey.toBytes()) !== backupRecord.publicKey) throw new Error("The backup wallet key does not match its public address.");
      const recordBase = Object.freeze({
        id: targetId,
        kind: "wallet" as const,
        version: 1 as const,
        label: backupRecord.label,
        address: backupRecord.address,
        publicKey: keyPair.publicKey.toBytes(),
        createdAt: backupRecord.createdAt,
      });
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(recordBase) }, deviceKey, secret);
      restored.push(Object.freeze({ ...recordBase, iv, ciphertext }));
    } finally {
      secret.fill(0);
    }
  }

  await writeStoredWallets(restored);
  return Object.freeze(restored.map(metadata));
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
