import { address } from "@solana/kit";
import type { WalletConnector, WalletSession } from "@solana/client";
import type { UseWalletConnectionReturnType } from "@solana/react-hooks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

let walletConnection: UseWalletConnectionReturnType;

vi.mock("@solana/react-hooks", () => ({
  useWalletConnection: () => walletConnection,
}));

import { SolanaWalletRegistryProvider, useSolanaWalletRegistry } from "../src/state/solana-wallet-registry";

const STORAGE_KEY = "sunder:solana-signing-connectors:v1";
const accountAddress = address("11111111111111111111111111111111");

function fixture() {
  const session: WalletSession = {
    account: { address: accountAddress, publicKey: new Uint8Array(32) },
    connector: { id: "phantom", name: "Phantom" },
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const connector: WalletConnector = {
    id: "phantom",
    name: "Phantom",
    canAutoConnect: true,
    isSupported: () => true,
    connect: vi.fn().mockResolvedValue(session),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const connect = vi.fn().mockResolvedValue(session);
  walletConnection = {
    connect,
    connected: false,
    connecting: false,
    connectors: [connector],
    connectorId: undefined,
    currentConnector: undefined,
    disconnect: vi.fn().mockResolvedValue(undefined),
    error: undefined,
    isReady: true,
    status: "disconnected",
    wallet: undefined,
  };
  return { connect, connector, session };
}

function RegistryProbe() {
  const registry = useSolanaWalletRegistry();
  return (
    <div>
      <button type="button" onClick={() => void registry.connect("phantom")}>Link Phantom</button>
      <output aria-label="Linked wallets">{registry.wallets.map((wallet) => `${wallet.connectorName}:${wallet.session.account.address.toString()}`).join("|")}</output>
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("Solana Wallet Standard registry", () => {
  it("links a real connector session and persists only its public connector id", async () => {
    const { connect } = fixture();
    const user = userEvent.setup();
    render(<SolanaWalletRegistryProvider><RegistryProbe /></SolanaWalletRegistryProvider>);

    await user.click(screen.getByRole("button", { name: "Link Phantom" }));

    await waitFor(() => expect(screen.getByLabelText("Linked wallets")).toHaveTextContent(`Phantom:${accountAddress}`));
    expect(connect).toHaveBeenCalledWith("phantom", { allowInteractiveFallback: true });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual(["phantom"]);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toContain("private");
  });

  it("restores a remembered connector without an interactive wallet prompt", async () => {
    const { connector } = fixture();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["phantom"]));

    render(<SolanaWalletRegistryProvider><RegistryProbe /></SolanaWalletRegistryProvider>);

    await waitFor(() => expect(connector.connect).toHaveBeenCalledWith({ autoConnect: true, allowInteractiveFallback: false }));
    await waitFor(() => expect(screen.getByLabelText("Linked wallets")).toHaveTextContent(`Phantom:${accountAddress}`));
  });
});
