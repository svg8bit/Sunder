import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, LoaderCircle, ShieldCheck, Unplug, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { formatUnits } from "viem";
import { useNetwork } from "../state/network";
import { useWorkspace } from "../state/workspace";
import { useEvmWalletState, useSolanaWalletState, type VerificationState } from "../wallets/hooks";
import { walletConnectConfigured } from "../evm/config";
import { Badge, Button, Modal, Panel } from "./ui";

function shorten(value: string | undefined): string {
  if (!value) return "Connect wallet";
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function formatSol(lamports: bigint | null | undefined): string {
  if (lamports === undefined || lamports === null) return "—";
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").slice(0, 4);
  return `${whole}.${fraction} SOL`;
}

function Verification({ verification }: { readonly verification: VerificationState }) {
  const { explorerTransactionUrl } = useNetwork();
  if (verification.state === "idle") return null;
  const tone = verification.state === "confirmed" ? "good" : verification.state === "failed" ? "bad" : "warn";
  return (
    <div className={`verification verification--${tone}`} role="status">
      <div className="verification__head">
        {verification.state === "confirmed" ? <CheckCircle2 size={17} /> : verification.state === "simulating" || verification.state === "submitted" ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}
        <strong>{verification.state.replaceAll("-", " ")}</strong>
      </div>
      <p>{verification.detail}</p>
      {"signature" in verification && verification.signature ? (
        <a href={explorerTransactionUrl(verification.signature)} target="_blank" rel="noreferrer">{verification.state === "confirmed" ? "Open confirmed transaction" : "Open transaction in explorer"} <ExternalLink size={13} /></a>
      ) : null}
    </div>
  );
}

export function WalletControl() {
  const [open, setOpen] = useState(false);
  const { family, network, chain } = useNetwork();
  const workspace = useWorkspace();
  const solana = useSolanaWalletState();
  const evm = useEvmWalletState();
  const address = family === "solana" ? solana.address : evm.address;
  const connected = family === "solana" ? solana.status === "connected" : evm.isConnected;
  const recordedVerification = useRef<string | null>(null);

  const verification = family === "solana" ? solana.verification : evm.verification;
  useEffect(() => {
    if (verification.state !== "confirmed" && verification.state !== "failed") return;
    const key = `${network}:${verification.state}:${"signature" in verification ? verification.signature ?? "" : ""}:${verification.detail}`;
    if (recordedVerification.current === key) return;
    recordedVerification.current = key;
    workspace.record({
      category: "wallet",
      action: `${chain.name} verification`,
      detail: verification.detail,
      state: verification.state,
      network,
      signature: "signature" in verification ? verification.signature : undefined,
    });
  }, [chain.name, network, verification, workspace]);

  const verifySolana = async () => {
    const result = await solana.verify();
    if (result.state === "confirmed") toast.success("Devnet verification confirmed by RPC.");
    else if (result.state === "submitted") toast.info("Devnet verification submitted; the modal will show canonical RPC status.");
    else if (result.state === "failed") toast.error(result.detail);
  };

  const verifyEvm = async () => {
    const result = await evm.verify();
    if (result.state === "confirmed") toast.success("Sepolia verification confirmed by canonical receipt.");
    else if (result.state === "submitted") toast.info("Sepolia verification submitted; the modal will show canonical receipt status.");
    else if (result.state === "failed") toast.error(result.detail);
  };

  return (
    <>
      <Button className="wallet-trigger" onClick={() => setOpen(true)} aria-label={connected ? `Wallet ${address}` : "Connect wallet"}>
        <WalletCards size={17} />
        <span>{shorten(address)}</span>
        {connected ? <span className="wallet-trigger__dot" /> : null}
      </Button>
      <Modal open={open} onOpenChange={setOpen} title={`${chain.name} wallet`} description="Self-custody only. Sunder never asks for a seed phrase or private key." className="wallet-modal">
        <div className="wallet-security"><ShieldCheck size={19} /><span>Signatures stay in your wallet. Watch-only addresses contain no secret material.</span></div>
        {family === "solana" ? (
          <div className="stack">
            {solana.status === "connected" ? (
              <Panel className="wallet-summary">
                <div><span>Address</span><strong>{shorten(solana.address)}</strong></div>
                <div><span>Balance</span><strong>{solana.balanceFetching ? "Loading…" : formatSol(solana.lamports)}</strong></div>
                <div><span>Connector</span><strong>{solana.currentConnector?.name ?? "Wallet Standard"}</strong></div>
              </Panel>
            ) : (
              <div className="connector-list">
                {solana.connectors.length === 0 ? <p className="muted">No Wallet Standard provider detected in this browser.</p> : solana.connectors.map((connector) => (
                  <Button key={connector.id} className="connector" onClick={() => void solana.connect(connector.id)}>
                    <WalletCards size={17} /> Connect {connector.name}
                  </Button>
                ))}
              </div>
            )}
            <Verification verification={solana.verification} />
            <div className="modal__actions">
              {solana.status === "connected" ? <Button variant="ghost" onClick={() => void solana.disconnect()}><Unplug size={16} /> Disconnect</Button> : null}
              <Button variant="primary" disabled={network !== "solana:devnet" || solana.status !== "connected" || ["simulating", "awaiting-signature", "submitted"].includes(solana.verification.state)} onClick={() => void verifySolana()}>
                Verify on Devnet
              </Button>
            </div>
          </div>
        ) : (
          <div className="stack">
            {evm.isConnected ? (
              <Panel className="wallet-summary">
                <div><span>Address</span><strong>{shorten(evm.address)}</strong></div>
                <div><span>Balance</span><strong>{evm.balanceFetching ? "Loading…" : evm.balance ? `${Number(formatUnits(evm.balance.value, evm.balance.decimals)).toFixed(4)} ${evm.balance.symbol}` : "—"}</strong></div>
                <div><span>Chain</span><strong>{evm.chain?.name ?? `Chain ${evm.chainId}`}</strong></div>
              </Panel>
            ) : (
              <div className="connector-list">
                {evm.connectors.map((connector) => (
                  <Button key={connector.uid} className="connector" disabled={evm.connectPending} onClick={() => void evm.connect({ connector, chainId: evm.targetChain.id })}>
                    <WalletCards size={17} /> Connect {connector.name}
                  </Button>
                ))}
                {!walletConnectConfigured ? <p className="muted">WalletConnect QR is locked until <code>VITE_WALLETCONNECT_PROJECT_ID</code> is configured. Injected EIP-1193 wallets remain available.</p> : null}
                {evm.connectError ? <p className="error-text">{evm.connectError.message}</p> : null}
              </div>
            )}
            {evm.isConnected && evm.chainId !== evm.targetChain.id ? (
              <Button onClick={() => void evm.switchChain({ chainId: evm.targetChain.id })}>Switch to {evm.targetChain.name}</Button>
            ) : null}
            <Verification verification={evm.verification} />
            <div className="modal__actions">
              {evm.isConnected ? <Button variant="ghost" onClick={() => evm.disconnect()}><Unplug size={16} /> Disconnect</Button> : null}
              <Button variant="primary" disabled={network !== "evm:sepolia" || !evm.isConnected || ["simulating", "awaiting-signature", "submitted"].includes(evm.verification.state)} onClick={() => void verifyEvm()}>
                Verify on Sepolia
              </Button>
            </div>
          </div>
        )}
        <div className="modal-footnote">
          <Badge tone={chain.production ? "warn" : "good"}>{chain.production ? "Interactive Mainnet" : "Test network"}</Badge>
          {chain.production
            ? "Manual trades can request an in-wallet signature after simulation. Persistent automation remains readiness-locked."
            : "Verification sends a tiny self-transaction and reports success only after RPC confirmation."}
        </div>
      </Modal>
    </>
  );
}
