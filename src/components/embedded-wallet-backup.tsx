import { Download, FileKey2, LoaderCircle, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useNetwork } from "../state/network";
import { useSolanaWalletRegistry } from "../state/solana-wallet-registry";
import { useWorkspace } from "../state/workspace";
import { Button, Modal } from "./ui";

export type EmbeddedWalletBackupMode = "backup" | "restore";

interface EmbeddedWalletBackupProps {
  readonly mode?: EmbeddedWalletBackupMode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

function downloadText(filename: string, value: string): void {
  const blob = new Blob([value], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function EmbeddedWalletBackup({ mode = "backup", open, onOpenChange }: EmbeddedWalletBackupProps) {
  const registry = useSolanaWalletRegistry();
  const { network } = useNetwork();
  const workspace = useWorkspace();
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [backupFile, setBackupFile] = useState("");
  const [backupFilename, setBackupFilename] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setPassphrase("");
      setConfirmation("");
      setBackupFile("");
      setBackupFilename("");
      setBusy(false);
    }
  }, [open]);

  const exportBackup = async () => {
    if (busy) return;
    if (passphrase !== confirmation) {
      toast.error("Backup passphrases do not match.");
      return;
    }
    setBusy(true);
    try {
      const serialized = await registry.exportEmbeddedBackup(passphrase);
      const day = new Date().toISOString().slice(0, 10);
      downloadText(`sunder-solana-wallets-${day}.json`, serialized);
      workspace.record({ category: "wallet", action: "Encrypted wallet backup exported", detail: "Device-local signer vault downloaded; no secret or passphrase was uploaded.", state: "local", network });
      toast.success("Encrypted wallet backup downloaded. Store the file and passphrase separately.");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async () => {
    if (busy) return;
    if (!backupFile) {
      toast.error("Select a Sunder encrypted wallet backup first.");
      return;
    }
    setBusy(true);
    try {
      const restored = await registry.restoreEmbeddedBackup(backupFile, passphrase);
      workspace.record({ category: "wallet", action: "Encrypted wallet backup restored", detail: `${restored.length} device-local signer${restored.length === 1 ? "" : "s"} restored and selected.`, state: "local", network });
      toast.success(`${restored.length} wallet${restored.length === 1 ? "" : "s"} restored, saved in this browser and selected.`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const readBackup = async (file?: File) => {
    setBackupFile("");
    setBackupFilename("");
    if (!file) return;
    if (file.size > 256_000) {
      toast.error("The selected backup is too large.");
      return;
    }
    try {
      setBackupFile(await file.text());
      setBackupFilename(file.name);
    } catch {
      toast.error("The selected backup could not be read.");
    }
  };

  const backingUp = mode === "backup";
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={backingUp ? "Back up embedded wallets" : "Restore embedded wallets"}
      description={backingUp ? "Download every Sunder-generated Solana signer as one passphrase-encrypted file." : "Restore an encrypted Sunder vault file into this browser profile."}
      className="embedded-backup-modal"
    >
      <div className="embedded-backup-notice"><ShieldCheck size={20} /><span><strong>Secrets stay encrypted.</strong> The backup is protected with PBKDF2-SHA256 and AES-256-GCM in this browser. Sunder never uploads the file or passphrase.</span></div>
      <div className="embedded-backup-form">
        {!backingUp ? <label className="embedded-backup-file">
          <span>Encrypted backup file</span>
          <input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => void readBackup(event.target.files?.[0])} />
          <b><FileKey2 size={15} /> {backupFilename || "Choose .json backup"}</b>
        </label> : null}
        <label>
          <span>Backup passphrase</span>
          <input type="password" value={passphrase} minLength={12} maxLength={256} autoComplete={backingUp ? "new-password" : "current-password"} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} placeholder="At least 12 characters" />
        </label>
        {backingUp ? <label>
          <span>Confirm passphrase</span>
          <input type="password" value={confirmation} minLength={12} maxLength={256} autoComplete="new-password" disabled={busy} onChange={(event) => setConfirmation(event.target.value)} placeholder="Repeat passphrase" />
        </label> : null}
      </div>
      <p className="embedded-backup-footnote">A forgotten passphrase cannot be recovered. Keep one offline copy; Phantom remains the recommended signer for larger funded balances.</p>
      <div className="modal__actions">
        <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" disabled={busy || passphrase.length < 12 || (backingUp ? confirmation.length < 12 : !backupFile)} onClick={() => void (backingUp ? exportBackup() : restoreBackup())}>
          {busy ? <LoaderCircle className="spin" size={15} /> : backingUp ? <Download size={15} /> : <Upload size={15} />}
          {backingUp ? "Download encrypted backup" : "Restore wallets"}
        </Button>
      </div>
    </Modal>
  );
}
