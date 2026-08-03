import { webcrypto } from "node:crypto";
import { getBase58Encoder, type SendableTransaction, type Transaction } from "@solana/kit";
import { Keypair } from "@solana/web3.js";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createEmbeddedWallet,
  createEmbeddedWalletSession,
  deleteEmbeddedWallet,
  exportEmbeddedWalletBackup,
  exportEmbeddedWalletPrivateKey,
  listEmbeddedWallets,
  restoreEmbeddedWalletBackup,
} from "../src/solana/embedded-wallet-vault";

beforeAll(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
});

describe("encrypted embedded Solana wallet vault", () => {
  it("persists metadata, exports the matching key only on request and signs a transaction", async () => {
    const wallet = await createEmbeddedWallet();
    expect(wallet.id).toMatch(/^embedded:/);
    expect(wallet.label).toBe("Sunder Wallet 1");
    expect(await listEmbeddedWallets()).toMatchObject([{ id: wallet.id, address: wallet.address }]);

    const exported = await exportEmbeddedWalletPrivateKey(wallet.id);
    const restored = Keypair.fromSecretKey(Uint8Array.from(getBase58Encoder().encode(exported)));
    expect(restored.publicKey.toBase58()).toBe(wallet.address);

    const transaction = {
      messageBytes: Uint8Array.from([1, 2, 3, 4]),
      signatures: Object.freeze({ [wallet.address]: null }),
      lifetimeConstraint: Object.freeze({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1n }),
    } as unknown as SendableTransaction & Transaction;
    const signed = await createEmbeddedWalletSession(wallet).signTransaction!(transaction);
    const signature = Object.values(signed.signatures)[0];
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature).toHaveLength(64);

    await deleteEmbeddedWallet(wallet.id);
    expect(await listEmbeddedWallets()).toEqual([]);
    await expect(exportEmbeddedWalletPrivateKey(wallet.id)).rejects.toThrow(/no longer exists/);
  });

  it("exports a passphrase-encrypted vault and restores the same signing key", async () => {
    const wallet = await createEmbeddedWallet();
    const privateKey = await exportEmbeddedWalletPrivateKey(wallet.id);
    const passphrase = "correct horse battery staple";
    const backup = await exportEmbeddedWalletBackup(passphrase);

    expect(backup).toContain("sunder-solana-embedded-vault-backup");
    expect(backup).not.toContain(privateKey);
    await deleteEmbeddedWallet(wallet.id);
    await expect(restoreEmbeddedWalletBackup(backup, "wrong password value")).rejects.toThrow(/Unable to decrypt/);
    expect(await listEmbeddedWallets()).toEqual([]);

    const restored = await restoreEmbeddedWalletBackup(backup, passphrase);
    expect(restored).toMatchObject([{ id: wallet.id, address: wallet.address }]);
    expect(await exportEmbeddedWalletPrivateKey(wallet.id)).toBe(privateKey);

    const restoredAgain = await restoreEmbeddedWalletBackup(backup, passphrase);
    expect(restoredAgain).toMatchObject([{ id: wallet.id, address: wallet.address }]);
    expect(await listEmbeddedWallets()).toHaveLength(1);
    await deleteEmbeddedWallet(wallet.id);
  });
});
