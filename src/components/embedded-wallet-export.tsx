import { Copy, Download, Eye, KeyRound, LoaderCircle, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { ConnectedSolanaWallet } from "../state/solana-wallet-registry";
import { useSolanaWalletRegistry } from "../state/solana-wallet-registry";
import { Button, Modal } from "./ui";

interface EmbeddedWalletExportProps {
  readonly wallet?: ConnectedSolanaWallet;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function EmbeddedWalletExport({ wallet, open, onOpenChange }: EmbeddedWalletExportProps) {
  const registry = useSolanaWalletRegistry();
  const [privateKey, setPrivateKey] = useState<string>();
  const [revealing, setRevealing] = useState(false);

  useEffect(() => {
    if (!open) {
      setPrivateKey(undefined);
      setRevealing(false);
    }
  }, [open]);

  const reveal = async () => {
    if (!wallet || wallet.kind !== "embedded" || revealing) return;
    setRevealing(true);
    try {
      setPrivateKey(await registry.exportEmbedded(wallet.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRevealing(false);
    }
  };

  const copyPrivateKey = async () => {
    if (!privateKey) return;
    try {
      await navigator.clipboard.writeText(privateKey);
      toast.success("Private key copied. Clear the clipboard after importing it.");
    } catch {
      toast.error("Clipboard permission was denied.");
    }
  };

  const download = () => {
    if (!privateKey || !wallet) return;
    const blob = new Blob([privateKey], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${wallet.connectorName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-solana-private-key.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Private key export downloaded.");
  };

  return (
    <Modal open={open && Boolean(wallet)} onOpenChange={onOpenChange} title={`Export ${wallet?.connectorName ?? "wallet"}`} description="The Base58 private key is decrypted only after this explicit action and is never sent to Sunder servers." className="embedded-key-modal">
      <div className="embedded-key-warning"><ShieldAlert size={20} /><span><strong>Anyone with this key controls the wallet.</strong> Import it only into a trusted Solana wallet, never paste it into support chats, and keep an offline backup before clearing browser data.</span></div>
      <div className="embedded-key-address"><span>Public address</span><code>{wallet?.session.account.address.toString()}</code></div>
      {privateKey ? (
        <div className="embedded-key-secret">
          <label htmlFor="embedded-private-key">Base58 private key</label>
          <textarea id="embedded-private-key" value={privateKey} readOnly rows={4} spellCheck={false} autoComplete="off" />
          <p>The key remains visible only while this dialog is open.</p>
        </div>
      ) : <div className="embedded-key-locked"><KeyRound size={22} /><strong>Private key hidden</strong><span>Reveal it only when you are ready to back up or import this wallet.</span></div>}
      <div className="modal__actions">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        {privateKey ? <><Button onClick={() => void copyPrivateKey()}><Copy size={15} /> Copy</Button><Button variant="primary" onClick={download}><Download size={15} /> Download</Button></> : <Button variant="primary" disabled={revealing} onClick={() => void reveal()}>{revealing ? <LoaderCircle className="spin" size={15} /> : <Eye size={15} />} Reveal private key</Button>}
      </div>
    </Modal>
  );
}
