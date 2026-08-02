export type WalletControlIntent = "connect" | "create";

export const WALLET_CONTROL_EVENT = "sunder:open-wallet";

export function openWalletControl(intent: WalletControlIntent = "connect"): void {
  window.dispatchEvent(new CustomEvent(WALLET_CONTROL_EVENT, { detail: Object.freeze({ intent }) }));
}
