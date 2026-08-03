import { useCallback, useMemo, useState } from "react";
import { useBalance as useSolanaBalance, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { compileTransaction, getBase64EncodedWireTransaction, signTransactionMessageWithSigners } from "@solana/kit";
import {
  useBalance as useEvmBalance,
  useConnect,
  useConnection,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { mainnet, sepolia } from "wagmi/chains";
import type { Hex } from "viem";
import { useNetwork } from "../state/network";
import { stringifySolanaRpcValue } from "../solana/rpc-errors";

export type VerificationState =
  | { readonly state: "idle" }
  | { readonly state: "simulating"; readonly detail: string }
  | { readonly state: "awaiting-signature"; readonly detail: string }
  | { readonly state: "submitted"; readonly detail: string; readonly signature: string }
  | { readonly state: "confirmed"; readonly detail: string; readonly signature: string }
  | { readonly state: "failed"; readonly detail: string; readonly signature?: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSolanaWalletState() {
  const { network } = useNetwork();
  const client = useSolanaClient();
  const connection = useWalletConnection();
  const address = connection.wallet?.account.address;
  const balance = useSolanaBalance(address);
  const [verification, setVerification] = useState<VerificationState>({ state: "idle" });

  const verify = useCallback(async (): Promise<VerificationState> => {
    if (network !== "solana:devnet") {
      const failed: VerificationState = { state: "failed", detail: "Verification transactions are restricted to Solana Devnet." };
      setVerification(failed);
      return failed;
    }
    if (connection.status !== "connected" || !connection.wallet) {
      const failed: VerificationState = { state: "failed", detail: "Connect a Wallet Standard wallet first." };
      setVerification(failed);
      return failed;
    }
    const session = connection.wallet;
    let signature: string | undefined;
    try {
      const endpoint = client.config.endpoint;
      if (!endpoint) throw new Error("Solana Devnet RPC endpoint is not configured.");
      const prepared = await client.solTransfer.prepareTransfer({
        amount: 1n,
        authority: session,
        destination: session.account.address,
        commitment: "confirmed",
      });
      setVerification({ state: "simulating", detail: "Simulating the exact 1-lamport self-transfer on Devnet." });
      const unsigned = compileTransaction(prepared.message);
      const unsignedSimulation = await client.runtime.rpc.simulateTransaction(getBase64EncodedWireTransaction(unsigned), {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: false,
        replaceRecentBlockhash: false,
      }).send();
      if (unsignedSimulation.value.err) throw new Error(`Devnet simulation failed: ${stringifySolanaRpcValue(unsignedSimulation.value.err)}`);
      setVerification({ state: "awaiting-signature", detail: "Simulation passed. Approve the Devnet transaction in your wallet." });

      if (prepared.mode === "partial") {
        const signed = await signTransactionMessageWithSigners(prepared.message);
        const wireTransaction = getBase64EncodedWireTransaction(signed);
        const signedSimulation = await client.runtime.rpc.simulateTransaction(wireTransaction, {
          encoding: "base64",
          commitment: "confirmed",
          sigVerify: true,
          replaceRecentBlockhash: false,
        }).send();
        if (signedSimulation.value.err) throw new Error(`Signed Devnet simulation failed: ${stringifySolanaRpcValue(signedSimulation.value.err)}`);
        signature = String(await client.runtime.rpc.sendTransaction(wireTransaction, {
          encoding: "base64",
          maxRetries: 2n,
          preflightCommitment: "confirmed",
          skipPreflight: false,
        }).send());
      } else {
        signature = String(await client.solTransfer.sendPreparedTransfer(prepared, {
          commitment: "confirmed",
          maxRetries: 2,
          skipPreflight: false,
        }));
      }
      setVerification({ state: "submitted", detail: "Submitted. Waiting for confirmed RPC signature status.", signature });
      const startedAt = Date.now();
      while (Date.now() - startedAt < 60_000) {
        const response = await client.runtime.rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send();
        const status = response.value[0];
        if (status?.err) throw new Error(`Devnet transaction failed: ${stringifySolanaRpcValue(status.err)}`);
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
          const confirmed: VerificationState = { state: "confirmed", detail: `RPC status: ${status.confirmationStatus}.`, signature };
          setVerification(confirmed);
          return confirmed;
        }
        const blockHeight = await client.runtime.rpc.getBlockHeight({ commitment: "confirmed" }).send();
        if (blockHeight > prepared.lifetime.lastValidBlockHeight) throw new Error("Devnet blockhash expired before confirmation.");
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      throw new Error("Devnet confirmation timed out.");
    } catch (error) {
      const failed: VerificationState = { state: "failed", detail: errorMessage(error), signature };
      setVerification(failed);
      return failed;
    }
  }, [client, connection.status, connection.wallet, network]);

  return {
    ...connection,
    address: address?.toString(),
    lamports: balance.lamports,
    balanceFetching: balance.fetching,
    verification,
    verify,
  };
}

export function useEvmWalletState() {
  const { network } = useNetwork();
  const targetChain = network === "evm:mainnet" ? mainnet : sepolia;
  const connection = useConnection();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const publicClient = usePublicClient({ chainId: targetChain.id });
  const walletClient = useWalletClient({ chainId: targetChain.id });
  const balance = useEvmBalance({
    address: connection.address,
    chainId: targetChain.id,
    query: { enabled: Boolean(connection.address) && network.startsWith("evm:") },
  });
  const [verification, setVerification] = useState<VerificationState>({ state: "idle" });

  const verify = useCallback(async (): Promise<VerificationState> => {
    if (network !== "evm:sepolia") {
      const failed: VerificationState = { state: "failed", detail: "Verification transactions are restricted to Ethereum Sepolia." };
      setVerification(failed);
      return failed;
    }
    if (!connection.isConnected || !connection.address) {
      const failed: VerificationState = { state: "failed", detail: "Connect an EIP-1193 wallet first." };
      setVerification(failed);
      return failed;
    }
    const expectedWalletAddress = connection.address;
    let transactionHash: Hex | undefined;
    try {
      let wallet = walletClient.data;
      if (connection.chainId !== sepolia.id) {
        await switchChain.switchChainAsync({ chainId: sepolia.id });
        wallet = (await walletClient.refetch()).data;
      }
      const publicRpc = publicClient;
      if (!publicRpc || !wallet) throw new Error("Sepolia wallet or RPC provider is unavailable.");
      const walletAddress = wallet.account.address;
      if (walletAddress.toLowerCase() !== expectedWalletAddress.toLowerCase()) {
        throw new Error("The wallet signing account changed. Reconnect and retry verification.");
      }
      setVerification({ state: "simulating", detail: "Running eth_call and estimateGas for a zero-value self-transfer." });
      await publicRpc.call({ account: walletAddress, to: walletAddress, value: 0n });
      const gas = await publicRpc.estimateGas({ account: walletAddress, to: walletAddress, value: 0n });
      const fees = await publicRpc.estimateFeesPerGas({ type: "eip1559" });
      if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) {
        throw new Error("Sepolia RPC did not return EIP-1559 fees.");
      }
      setVerification({ state: "awaiting-signature", detail: "Simulation passed. Approve the Sepolia self-transfer in your wallet." });
      transactionHash = await wallet.sendTransaction({
        account: walletAddress,
        chain: sepolia,
        to: walletAddress,
        value: 0n,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      setVerification({ state: "submitted", detail: "Submitted. Waiting for a canonical receipt with two confirmations.", signature: transactionHash });
      const receipt = await publicRpc.waitForTransactionReceipt({ hash: transactionHash, confirmations: 2, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error("Sepolia receipt status is reverted.");
      const canonicalBlock = await publicRpc.getBlock({ blockNumber: receipt.blockNumber, includeTransactions: false });
      if (canonicalBlock.hash !== receipt.blockHash) throw new Error("Sepolia receipt was reorged from the canonical chain.");
      const confirmedTransaction = await publicRpc.getTransaction({ hash: transactionHash });
      if (
        confirmedTransaction.hash.toLowerCase() !== transactionHash.toLowerCase()
        || confirmedTransaction.from.toLowerCase() !== walletAddress.toLowerCase()
        || confirmedTransaction.to?.toLowerCase() !== walletAddress.toLowerCase()
        || confirmedTransaction.value !== 0n
      ) {
        throw new Error("Sepolia receipt does not match the signed zero-value self-transfer intent.");
      }
      const confirmed: VerificationState = { state: "confirmed", detail: `Canonical receipt and self-transfer intent verified at block ${receipt.blockNumber}.`, signature: transactionHash };
      setVerification(confirmed);
      return confirmed;
    } catch (error) {
      const failed: VerificationState = { state: "failed", detail: errorMessage(error), signature: transactionHash };
      setVerification(failed);
      return failed;
    }
  }, [connection.address, connection.chainId, connection.isConnected, network, publicClient, switchChain, walletClient]);

  return useMemo(() => ({
    ...connection,
    connectors: connect.connectors,
    connect: connect.connectAsync,
    connectPending: connect.isPending,
    connectError: connect.error,
    disconnect: disconnect.disconnect,
    balance: balance.data,
    balanceFetching: balance.isFetching,
    targetChain,
    switchChain: switchChain.switchChainAsync,
    verification,
    verify,
  }), [balance.data, balance.isFetching, connect.connectAsync, connect.connectors, connect.error, connect.isPending, connection, disconnect.disconnect, switchChain.switchChainAsync, targetChain, verification, verify]);
}
