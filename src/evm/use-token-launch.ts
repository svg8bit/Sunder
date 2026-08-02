import { useCallback, useState } from "react";
import { useConnection, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { mainnet, sepolia } from "wagmi/chains";
import { encodeDeployData, parseUnits, type Address, type Hex } from "viem";
import { useNetwork } from "../state/network";
import { SUNDER_FIXED_SUPPLY_TOKEN_ABI, SUNDER_FIXED_SUPPLY_TOKEN_BYTECODE } from "./generated/sunder-fixed-supply-token";
import { validateTokenDecimals } from "./token-input";

export type TokenLaunchState =
  | { readonly state: "idle" }
  | { readonly state: "simulating"; readonly detail: string }
  | { readonly state: "awaiting-signature"; readonly detail: string }
  | { readonly state: "submitted"; readonly detail: string; readonly transactionHash: Hex }
  | { readonly state: "confirmed"; readonly detail: string; readonly transactionHash: Hex; readonly contractAddress: Address }
  | { readonly state: "failed"; readonly detail: string; readonly transactionHash?: Hex };

export interface FixedSupplyTokenInput {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly displaySupply: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useEvmTokenLaunch() {
  const { network } = useNetwork();
  const targetChain = network === "evm:mainnet" ? mainnet : sepolia;
  const connection = useConnection();
  const publicClient = usePublicClient({ chainId: targetChain.id });
  const walletClient = useWalletClient({ chainId: targetChain.id });
  const switchChain = useSwitchChain();
  const [status, setStatus] = useState<TokenLaunchState>({ state: "idle" });

  const deploy = useCallback(async (input: FixedSupplyTokenInput) => {
    if (network !== "evm:sepolia") {
      const failed: TokenLaunchState = { state: "failed", detail: "Direct token deployment is restricted to Sepolia until every Mainnet readiness gate passes." };
      setStatus(failed);
      return failed;
    }
    if (!connection.isConnected || !connection.address) {
      const failed: TokenLaunchState = { state: "failed", detail: "Connect an EIP-1193 wallet before deployment." };
      setStatus(failed);
      return failed;
    }
    const expectedDeployer = connection.address;
    let transactionHash: Hex | undefined;
    try {
      let wallet = walletClient.data;
      if (connection.chainId !== sepolia.id) {
        await switchChain.switchChainAsync({ chainId: sepolia.id });
        wallet = (await walletClient.refetch()).data;
      }
      const rpc = publicClient;
      if (!rpc || !wallet) throw new Error("Sepolia wallet or RPC provider is unavailable.");
      const deployer = wallet.account.address;
      if (deployer.toLowerCase() !== expectedDeployer.toLowerCase()) {
        throw new Error("The wallet signing account changed. Reconnect and retry the deployment.");
      }
      const decimals = validateTokenDecimals(input.decimals);
      const cleanSupply = input.displaySupply.replaceAll(",", "");
      const totalSupply = parseUnits(cleanSupply, decimals);
      if (totalSupply <= 0n) throw new Error("Token supply must be positive.");
      const deployData = encodeDeployData({
        abi: SUNDER_FIXED_SUPPLY_TOKEN_ABI,
        bytecode: SUNDER_FIXED_SUPPLY_TOKEN_BYTECODE,
        args: [input.name, input.symbol.toUpperCase(), decimals, totalSupply, deployer],
      });
      setStatus({ state: "simulating", detail: "Running eth_call and estimateGas for the exact fixed-supply contract creation." });
      await rpc.call({ account: deployer, data: deployData });
      const gasEstimate = await rpc.estimateGas({ account: deployer, data: deployData });
      const fees = await rpc.estimateFeesPerGas({ type: "eip1559" });
      if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) {
        throw new Error("Sepolia RPC did not return EIP-1559 fee data.");
      }
      const gas = gasEstimate * 120n / 100n;
      setStatus({ state: "awaiting-signature", detail: "Exact deployment simulation passed. Approve the Sepolia contract creation in your wallet." });
      transactionHash = await wallet.deployContract({
        account: deployer,
        chain: sepolia,
        abi: SUNDER_FIXED_SUPPLY_TOKEN_ABI,
        bytecode: SUNDER_FIXED_SUPPLY_TOKEN_BYTECODE,
        args: [input.name, input.symbol.toUpperCase(), decimals, totalSupply, deployer],
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      setStatus({ state: "submitted", detail: "Deployment submitted. Waiting for a canonical receipt with two confirmations.", transactionHash });
      const receipt = await rpc.waitForTransactionReceipt({ hash: transactionHash, confirmations: 2, timeout: 180_000 });
      if (receipt.status !== "success") throw new Error("Token deployment receipt status is reverted.");
      if (!receipt.contractAddress) throw new Error("Confirmed deployment receipt did not contain a contract address.");
      const canonicalBlock = await rpc.getBlock({ blockNumber: receipt.blockNumber, includeTransactions: false });
      if (canonicalBlock.hash !== receipt.blockHash) throw new Error("Deployment receipt was reorged from the canonical chain.");
      const confirmed: TokenLaunchState = {
        state: "confirmed",
        detail: `Fixed-supply ERC-20 confirmed at block ${receipt.blockNumber}.`,
        transactionHash,
        contractAddress: receipt.contractAddress,
      };
      setStatus(confirmed);
      return confirmed;
    } catch (error) {
      const failed: TokenLaunchState = { state: "failed", detail: errorMessage(error), transactionHash };
      setStatus(failed);
      return failed;
    }
  }, [connection.address, connection.chainId, connection.isConnected, network, publicClient, switchChain, walletClient]);

  return {
    status,
    deploy,
    reset: () => setStatus({ state: "idle" }),
    connected: connection.isConnected,
    address: connection.address,
  };
}
