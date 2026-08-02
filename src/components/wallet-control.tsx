import { useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, ExternalLink, LoaderCircle, Plus, ShieldCheck, Unplug, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { formatUnits } from "viem";
import { useNetwork } from "../state/network";
import { useWorkspace } from "../state/workspace";
import { useSolanaWalletRegistry } from "../state/solana-wallet-registry";
import { useEvmWalletState, useSolanaWalletState, type VerificationState } from "../wallets/hooks";
import { walletConnectConfigured } from "../evm/config";
import { WALLET_CONTROL_EVENT, type WalletControlIntent } from "../wallets/control-event";
import { Badge, Button, Modal, Panel } from "./ui";

const SOLANA_WALLET_PROVIDERS = Object.freeze([
  { name: "Phantom", href: "https://phantom.com/download" },
  { name: "Solflare", href: "https://www.solflare.com/download/" },
  { name: "Backpack", href: "https://backpack.app/download" },
]);

function shorten(value: string | undefined): string {
  if (!value) return "Connect wallet";
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
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
  const [intent, setIntent] = useState<WalletControlIntent>("connect");
  const { family, network, chain } = useNetwork();
  const workspace = useWorkspace();
  const solana = useSolanaWalletState();
  const solanaRegistry = useSolanaWalletRegistry();
  const evm = useEvmWalletState();
  const solanaAddress = solana.address ?? solanaRegistry.wallets[0]?.session.account.address.toString();
  const address = family === "solana" ? solanaAddress : evm.address;
  const connected = family === "solana" ? solanaRegistry.wallets.length > 0 : evm.isConnected;
  const recordedVerification = useRef<string | null>(null);
  const recordedSignerLinks = useRef(new Set<string>());

  const verification = family === "solana" ? solana.verification : evm.verification;
  useEffect(() => {
    const openWallet = (event: Event) => {
      const nextIntent = event instanceof CustomEvent && event.detail?.intent === "create" ? "create" : "connect";
      setIntent(nextIntent);
      setOpen(true);
    };
    window.addEventListener(WALLET_CONTROL_EVENT, openWallet);
    return () => window.removeEventListener(WALLET_CONTROL_EVENT, openWallet);
  }, []);
  useEffect(() => {
    const signerNetwork = network.startsWith("solana:") ? network : "solana:mainnet";
    for (const entry of solanaRegistry.wallets) {
      const signerAddress = entry.session.account.address.toString();
      const key = `${signerNetwork}:${signerAddress}`;
      const alreadyRecorded = recordedSignerLinks.current.has(key) || workspace.audit.some((auditEntry) => auditEntry.network === signerNetwork && auditEntry.category === "wallet" && auditEntry.action === "Signer wallet linked" && auditEntry.detail.includes(signerAddress));
      if (alreadyRecorded) continue;
      recordedSignerLinks.current.add(key);
      workspace.record({ category: "wallet", action: "Signer wallet linked", detail: `${entry.connectorName} · ${signerAddress}; public connector session only.`, state: "local", network: signerNetwork });
    }
  }, [network, solanaRegistry.wallets, workspace]);
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
      <Button className="wallet-trigger" onClick={() => { setIntent("connect"); setOpen(true); }} aria-label={connected ? `Wallet ${address}` : "Connect wallet"}>
        <WalletCards size={17} />
        <span>{shorten(address)}</span>
        {connected ? <span className="wallet-trigger__dot" /> : null}
      </Button>
      <Modal open={open} onOpenChange={setOpen} title={`${intent === "create" ? "Create or connect" : "Connect"} ${chain.name} wallet`} description="Self-custody only. Wallet creation and secret export stay inside the selected wallet provider." className="wallet-modal">
        <div className="wallet-security"><ShieldCheck size={19} /><span>Signatures stay in your wallet. Watch-only addresses contain no secret material.</span></div>
        {family === "solana" ? (
          <div className="stack">
            {intent === "create" ? <div className="wallet-create-guidance"><Plus size={18} /><div><strong>Create a real signer wallet</strong><span>Create/select the account inside Phantom, Solflare or Backpack, approve the connection, and its public address will appear in the terminal already selected. One active signer session is kept per provider; use three providers for three independently signing wallets.</span></div></div> : null}
            {solanaRegistry.wallets.length > 0 ? <div className="wallet-registry-list">{solanaRegistry.wallets.map((entry) => (
              <Panel className="wallet-summary" key={entry.id}>
                <div><span>{entry.connectorName}</span><strong>{shorten(entry.session.account.address.toString())}</strong></div>
                <div><span>Signer</span><strong>Wallet Standard</strong></div>
                <Button size="sm" variant="ghost" onClick={() => void solanaRegistry.disconnect(entry.id)}><Unplug size={14} /> Disconnect</Button>
              </Panel>
            ))}</div> : null}
            <div className="connector-list">
              {solanaRegistry.connectors.length === 0 ? <p className="muted">No Wallet Standard provider detected in this browser.</p> : solanaRegistry.connectors.map((connector) => {
                const connectedConnector = solanaRegistry.wallets.some((entry) => entry.connectorId === connector.id);
                return <Button key={connector.id} className="connector" disabled={connectedConnector || Boolean(solanaRegistry.connectingConnectorId)} onClick={() => void solanaRegistry.connect(connector.id).catch((connectError) => toast.error(connectError instanceof Error ? connectError.message : String(connectError)))}>
                  {connectedConnector ? <Check size={17} /> : solanaRegistry.connectingConnectorId === connector.id ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} {connectedConnector ? `${connector.name} linked` : `${intent === "create" ? "Create / connect with" : "Connect"} ${connector.name}`}
                </Button>;
              })}
            </div>
            {solanaRegistry.connectors.length === 0 ? <div className="wallet-create-links">{SOLANA_WALLET_PROVIDERS.map((provider) => <a key={provider.name} href={provider.href} target="_blank" rel="noreferrer"><Plus size={15} /> Install / create with {provider.name} <ExternalLink size={13} /></a>)}</div> : null}
            <Verification verification={solana.verification} />
            <div className="modal__actions">
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
