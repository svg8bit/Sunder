import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/wallet-control", () => ({
  WalletControl: () => <button type="button">Connect wallet</button>,
}));

vi.mock("../src/evm/use-token-launch", () => ({
  useEvmTokenLaunch: () => ({
    status: { state: "idle" as const },
    deploy: vi.fn(),
    reset: vi.fn(),
    connected: false,
    address: undefined,
  }),
}));

import { AppShell } from "../src/components/shell";
import { LaunchStudioScreen } from "../src/screens/launch-studio";
import { SniperScreen } from "../src/screens/sniper";
import { NetworkProvider } from "../src/state/network";
import { useWorkspace, WorkspaceProvider } from "../src/state/workspace";

const STORAGE_KEY = "sunder:network-selection:v1";

function selection(family: "solana" | "evm", network?: "solana:devnet" | "solana:mainnet" | "evm:sepolia" | "evm:mainnet") {
  const value = {
    family,
    solana: network?.startsWith("solana:") ? network : "solana:devnet",
    evm: network?.startsWith("evm:") ? network : "evm:sepolia",
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

function renderWorkspace(child: React.ReactNode) {
  return render(<NetworkProvider><WorkspaceProvider>{child}</WorkspaceProvider></NetworkProvider>);
}

function AuditProbe() {
  const { audit } = useWorkspace();
  return <output aria-label="Audit actions">{audit.map((entry) => entry.action).join(" | ")}</output>;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/launch");
});

describe("dual-chain application shell", () => {
  it("switches network family, persists each selection, and exposes the selected family accessibly", async () => {
    const user = userEvent.setup();
    renderWorkspace(<AppShell route="launch" navigate={vi.fn()}><div>Screen</div></AppShell>);
    const solana = screen.getByRole("button", { name: "SOL" });
    const evm = screen.getByRole("button", { name: "EVM" });
    expect(solana).toHaveAttribute("aria-pressed", "true");
    await user.click(evm);
    expect(evm).toHaveAttribute("aria-pressed", "true");
    const network = screen.getByRole("combobox", { name: "Network" });
    expect(network).toHaveValue("evm:sepolia");
    await user.selectOptions(network, "evm:mainnet");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({ family: "evm", evm: "evm:mainnet", solana: "solana:devnet" });
  });

  it("removes the closed drawer from focus and accessibility navigation", async () => {
    const user = userEvent.setup();
    renderWorkspace(<AppShell route="launch" navigate={vi.fn()}><div>Screen</div></AppShell>);
    const drawer = document.getElementById("workspace-drawer");
    expect(drawer).toHaveAttribute("aria-hidden", "true");
    expect(drawer).toHaveAttribute("inert");
    const toggle = screen.getByRole("button", { name: "Toggle navigation" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(drawer).toHaveAttribute("aria-hidden", "false");
    expect(drawer).not.toHaveAttribute("inert");
    expect(screen.getAllByRole("button", { name: /Notifications/ })).toHaveLength(2);
  });

  it("persists Solana Mainnet independently and keeps funded launch execution locked", async () => {
    selection("solana", "solana:mainnet");
    const user = userEvent.setup();
    renderWorkspace(<AppShell route="launch" navigate={vi.fn()}><LaunchStudioScreen /></AppShell>);
    const network = screen.getByRole("combobox", { name: "Network" });
    expect(network).toHaveValue("solana:mainnet");
    expect(screen.getByRole("button", { name: "Deploy to Mainnet" })).toBeDisabled();
    expect(screen.getByText("Funded Mainnet locked")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "EVM" }));
    expect(network).toHaveValue("evm:sepolia");
    await user.click(screen.getByRole("button", { name: "SOL" }));
    expect(network).toHaveValue("solana:mainnet");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({ family: "solana", solana: "solana:mainnet", evm: "evm:sepolia" });
  });

  it("resets Sniper address, fee units, and relay defaults when the chain family changes", async () => {
    const user = userEvent.setup();
    renderWorkspace(<AppShell route="sniper" navigate={vi.fn()}><SniperScreen /></AppShell>);
    await waitFor(() => expect(screen.getByDisplayValue("So11111111111111111111111111111111111111112")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "EVM" }));
    await waitFor(() => expect(screen.getByDisplayValue("0x0000000000000000000000000000000000000000")).toBeInTheDocument());
    expect(screen.getByLabelText("Health-weighted routing")).toHaveValue("rpc-protect");
    expect(screen.getByLabelText(/Max fee per gas/).parentElement).toHaveTextContent("Gwei");
  });
});

describe("EVM product parity and safety", () => {
  it("renders authenticated EVM tax, CREATE2, anti-farmer and venue controls without secret-key inputs", async () => {
    selection("evm", "evm:sepolia");
    const user = userEvent.setup();
    renderWorkspace(<LaunchStudioScreen />);
    await user.click(screen.getByRole("button", { name: /Controls/ }));
    const taxMode = await screen.findByRole("switch", { name: "Tax factory mode" });
    await user.click(taxMode);
    expect(screen.getByLabelText("Buy tax %")).toBeInTheDocument();
    expect(screen.getByLabelText("Sell tax %")).toBeInTheDocument();
    expect(screen.getByLabelText("Tax duration (seconds)")).toHaveValue(86_400);
    expect(screen.getByLabelText(/Anti-farmer duration \(seconds\)/)).toBeInTheDocument();
    expect(screen.getByLabelText(/CREATE2 salt \(optional\)/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/private key|seed phrase|mnemonic/i)).not.toBeInTheDocument();
  });

  it("uses EIP-1559 units and V2/V3/V4 venue selection in the Sniper console", async () => {
    selection("evm", "evm:sepolia");
    renderWorkspace(<SniperScreen />);
    await waitFor(() => expect(screen.getByLabelText("Venue")).toHaveTextContent("Auto-detect V2/V3/V4"));
    expect(screen.getByLabelText(/Max fee per gas/).parentElement).toHaveTextContent("Gwei");
    expect(screen.getByText("RPC + Flashbots Protect")).toBeInTheDocument();
    expect(screen.getByText("No false success")).toBeInTheDocument();
  });

  it("keeps Ethereum Mainnet deployment disabled even after a local manifest validation", async () => {
    selection("evm", "evm:mainnet");
    const user = userEvent.setup();
    renderWorkspace(<LaunchStudioScreen />);
    const deploy = screen.getByRole("button", { name: "Deploy to Mainnet" });
    expect(deploy).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Run validation" }));
    await waitFor(() => expect(screen.getByText("Manifest passed")).toBeInTheDocument());
    expect(deploy).toBeDisabled();
    expect(screen.getByText("Funded Mainnet locked")).toBeInTheDocument();
  });

  it("invalidates a passed manifest after edits and keeps readiness checks out of the locked audit", async () => {
    selection("evm", "evm:sepolia");
    const user = userEvent.setup();
    renderWorkspace(<><LaunchStudioScreen /><AuditProbe /></>);
    await user.click(screen.getByRole("button", { name: "Run validation" }));
    await waitFor(() => expect(screen.getByText("Manifest passed")).toBeInTheDocument());
    expect(screen.getByLabelText("Audit actions")).toHaveTextContent("Launch manifest validated");

    const name = screen.getByLabelText("Token name");
    await user.clear(name);
    await user.type(name, "Changed token");
    await waitFor(() => expect(screen.getByText("Not run")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Readiness" }));
    expect(screen.getByLabelText("Audit actions")).not.toHaveTextContent("Launch remained locked");
  });
});
