import { zodResolver } from "@hookform/resolvers/zod";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronRight, CircleDollarSign, FileCheck2, Info, Play, Rocket, ShieldAlert, Sparkles, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useNetwork } from "../state/network";
import { useWorkspace } from "../state/workspace";
import { Badge, Button, Field, Input, Panel, Segmented, Select, Textarea, Toggle } from "../components/ui";
import { useEvmTokenLaunch } from "../evm/use-token-launch";

const launchModes = ["Quick Deploy", "Bundle", "Snipe", "LBS", "Dev only"] as const;

const launchSchema = z.object({
  name: z.string().trim().min(2, "Use at least 2 characters.").max(32),
  symbol: z.string().trim().min(2, "Use at least 2 characters.").max(10).regex(/^[A-Za-z0-9]+$/, "Letters and numbers only."),
  description: z.string().trim().min(12, "Describe the token transparently.").max(512),
  website: z.union([z.literal(""), z.url()]),
  decimals: z.number().int().min(0).max(18),
  supply: z.string().max(96, "Supply is too large.")
    .regex(/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/, "Use plain digits or correctly grouped thousands.")
    .refine((value) => /[1-9]/.test(value), "Enter a positive supply."),
  platform: z.string().min(1),
  tokenMode: z.string().min(1),
  initialLiquidity: z.string().regex(/^\d*(?:\.\d+)?$/, "Enter a valid amount."),
  launchMode: z.enum(launchModes),
  taxEnabled: z.boolean(),
  buyTax: z.number().min(0).max(20),
  sellTax: z.number().min(0).max(20),
  marketingBps: z.number().int().min(0).max(10_000),
  reflectionsBps: z.number().int().min(0).max(10_000),
  burnBps: z.number().int().min(0).max(10_000),
  liquidityBps: z.number().int().min(0).max(10_000),
  taxDurationSeconds: z.number().int().min(0),
  antiFarmerSeconds: z.number().int().min(0).max(86_400),
  create2Salt: z.string().max(66),
  revokeMintAuthority: z.boolean(),
  freezeAuthority: z.boolean(),
}).superRefine((data, context) => {
  if (!data.taxEnabled) return;
  const distribution = data.marketingBps + data.reflectionsBps + data.burnBps + data.liquidityBps;
  if (distribution !== 10_000) context.addIssue({ code: "custom", path: ["marketingBps"], message: `Tax distribution must total 10,000 BPS; current total is ${distribution}.` });
  if (data.taxDurationSeconds < 86_400) context.addIssue({ code: "custom", path: ["taxDurationSeconds"], message: "Tax duration must be at least 86,400 seconds." });
});

type LaunchForm = z.infer<typeof launchSchema>;

const stepCopy = [
  { label: "Identity", detail: "Define your token" },
  { label: "Supply", detail: "Set launch economics" },
  { label: "Controls", detail: "Configure authorities" },
  { label: "Review", detail: "Verify and deploy" },
] as const;

function StepRail({ step, onStep }: { readonly step: number; readonly onStep: (step: number) => void }) {
  return (
    <aside className="step-rail" aria-label="Launch steps">
      {stepCopy.map((item, index) => (
        <button key={item.label} type="button" className={index + 1 === step ? "is-active" : index + 1 < step ? "is-complete" : ""} onClick={() => onStep(index + 1)}>
          <span className="step-rail__number">{index + 1 < step ? <Check size={15} /> : index + 1}</span>
          <span><strong>{item.label}</strong><small>{item.detail}</small></span>
        </button>
      ))}
    </aside>
  );
}

export function LaunchStudioScreen() {
  const { family, network, chain } = useNetwork();
  const workspace = useWorkspace();
  const evmLaunch = useEvmTokenLaunch();
  const [step, setStep] = useState(1);
  const [simulation, setSimulation] = useState<"idle" | "running" | "passed" | "failed">("idle");
  const [projectId, setProjectId] = useState<string | undefined>();
  const validatedManifest = useRef<string | null>(null);
  const form = useForm<LaunchForm>({
    resolver: zodResolver(launchSchema),
    mode: "onChange",
    defaultValues: {
      name: "Sunder Test",
      symbol: "SNDR",
      description: "A transparent test launch configuration created with Sunder.",
      website: "",
      decimals: family === "solana" ? 9 : 18,
      supply: "1,000,000",
      platform: family === "solana" ? "Pump" : "Standard ERC-20",
      tokenMode: family === "solana" ? "Classic SPL" : "No tax",
      initialLiquidity: "0",
      launchMode: "Quick Deploy",
      taxEnabled: false,
      buyTax: 0,
      sellTax: 0,
      marketingBps: 10_000,
      reflectionsBps: 0,
      burnBps: 0,
      liquidityBps: 0,
      taxDurationSeconds: 86_400,
      antiFarmerSeconds: 0,
      create2Salt: "",
      revokeMintAuthority: true,
      freezeAuthority: false,
    },
  });
  const values = useWatch({ control: form.control });
  const manifestFingerprint = JSON.stringify(values);
  const launchMode = values.launchMode ?? "Quick Deploy";
  const taxTotal = Number(values.marketingBps ?? 0) + Number(values.reflectionsBps ?? 0) + Number(values.burnBps ?? 0) + Number(values.liquidityBps ?? 0);
  const adapterReady = family === "evm" && values.platform === "Standard ERC-20" && !values.taxEnabled;
  const fundedExecutionReady = network === "evm:sepolia" && adapterReady && evmLaunch.connected;

  useEffect(() => {
    form.setValue("decimals", family === "solana" ? 9 : 18, { shouldValidate: true });
    form.setValue("platform", family === "solana" ? "Pump" : "Standard ERC-20", { shouldValidate: true });
    form.setValue("tokenMode", family === "solana" ? "Classic SPL" : "No tax", { shouldValidate: true });
    form.setValue("taxEnabled", false, { shouldValidate: true });
    form.setValue("create2Salt", "", { shouldValidate: true });
    validatedManifest.current = null;
    setSimulation("idle");
    setProjectId(undefined);
  }, [family, form]);

  useEffect(() => {
    if (simulation === "passed" && validatedManifest.current !== manifestFingerprint) {
      setSimulation("idle");
    }
  }, [manifestFingerprint, simulation]);

  const platformOptions = useMemo(() => family === "solana"
    ? ["Pump", "Bonk", "Bonkers", "LaunchLab", "Bags", "Printr"]
    : ["Standard ERC-20", "Configured factory", "Existing token / CTO"], [family]);

  const changeMode = (value: LaunchForm["launchMode"]) => form.setValue("launchMode", value, { shouldDirty: true, shouldValidate: true });

  const validateSimulation = form.handleSubmit(async (data) => {
    const candidateManifest = JSON.stringify(form.getValues());
    setSimulation("running");
    await new Promise((resolve) => setTimeout(resolve, 220));
    if (candidateManifest !== JSON.stringify(form.getValues())) {
      validatedManifest.current = null;
      setSimulation("idle");
      toast.info("Launch configuration changed. Run validation again.");
      return;
    }
    const savedProjectId = workspace.saveProject({
      id: projectId,
      name: data.name,
      symbol: data.symbol.toUpperCase(),
      network,
      status: "Draft",
      launchMode: data.launchMode,
    });
    setProjectId(savedProjectId);
    workspace.record({
      category: "simulation",
      action: "Launch manifest validated",
      detail: `${data.symbol.toUpperCase()} · ${data.platform} · local manifest only; no transaction submitted.`,
      state: "passed",
      network,
    });
    validatedManifest.current = candidateManifest;
    setSimulation("passed");
    toast.success("Launch manifest validated. No on-chain action was submitted.");
  }, () => {
    validatedManifest.current = null;
    setSimulation("failed");
    toast.error("Resolve the highlighted launch configuration errors.");
  });

  const lockedDeploy = () => {
    workspace.record({
      category: "execution",
      action: "Launch remained locked",
      detail: chain.production ? "Mainnet operator gate is locked." : "The selected launch adapter is not configured.",
      state: "locked",
      network,
    });
    toast.warning(chain.production ? "Mainnet launch is locked by operator policy." : "Configure the verified launch adapter before deployment.");
  };

  const explainReadiness = () => {
    if (chain.production) {
      toast.info("Mainnet requires configured RPC, relay and signer policy, sufficient funding, and explicit operator confirmation.");
    } else if (!adapterReady) {
      toast.info("Select the verified Standard ERC-20 adapter with tax mode disabled.");
    } else if (!evmLaunch.connected) {
      toast.info("Connect an EIP-1193 wallet before Sepolia deployment.");
    } else if (simulation !== "passed") {
      toast.info("Wallet and adapter are ready. Run validation for the current manifest.");
    } else {
      toast.info("Sepolia readiness passed. The connected wallet must approve the exact simulated deployment.");
    }
  };

  const deploy = form.handleSubmit(async (data) => {
    if (family !== "evm" || network !== "evm:sepolia" || data.platform !== "Standard ERC-20" || data.taxEnabled) {
      lockedDeploy();
      return;
    }
    const result = await evmLaunch.deploy({
      name: data.name,
      symbol: data.symbol,
      decimals: data.decimals,
      displaySupply: data.supply,
    });
    if (result.state !== "confirmed") {
      const detail = result.state === "failed" ? result.detail : "Deployment did not reach a canonical receipt.";
      workspace.record({ category: "execution", action: "Sepolia token deployment not confirmed", detail, state: "failed", network });
      toast.error(detail);
      return;
    }
    const savedProjectId = workspace.saveProject({
      id: projectId,
      name: data.name,
      symbol: data.symbol.toUpperCase(),
      network,
      status: "Confirmed",
      launchMode: data.launchMode,
      tokenAddress: result.contractAddress,
      signature: result.transactionHash,
    });
    setProjectId(savedProjectId);
    workspace.record({
      category: "execution",
      action: "Sepolia fixed-supply token confirmed",
      detail: `${result.contractAddress} · canonical receipt required and observed.`,
      state: "confirmed",
      network,
      signature: result.transactionHash,
    });
    toast.success("ERC-20 deployment confirmed on Sepolia.");
  });

  return (
    <div className="launch-screen screen--edge">
      <div className="screen-heading launch-heading">
        <div><span className="eyebrow">Execution console / {chain.name}</span><h1>Launch Studio</h1><p>Build a transparent, simulation-first token launch.</p></div>
        <Segmented value={launchMode} onChange={changeMode} ariaLabel="Launch mode" options={launchModes.map((mode) => ({ value: mode, label: mode }))} />
      </div>
      <div className="launch-grid">
        <StepRail step={step} onStep={setStep} />
        <form className="launch-form" onSubmit={(event) => event.preventDefault()}>
          <AnimatePresence mode="wait">
            <motion.div key={`${family}-${step}`} initial={{ opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.16 }}>
              {step === 1 ? (
                <div className="form-section">
                  <div className="section-heading"><div><h2>Identity</h2><p>Define the basic details of your token.</p></div><Badge tone="accent">{family === "solana" ? "SPL" : "ERC-20"}</Badge></div>
                  <Field label="Token name" valid={!form.formState.errors.name && Boolean(values.name)} error={form.formState.errors.name?.message}><Input {...form.register("name")} /></Field>
                  <Field label="Symbol" valid={!form.formState.errors.symbol && Boolean(values.symbol)} error={form.formState.errors.symbol?.message}><Input {...form.register("symbol")} /></Field>
                  <Field label="Description" valid={!form.formState.errors.description && Boolean(values.description)} error={form.formState.errors.description?.message}><Textarea rows={3} {...form.register("description")} /></Field>
                  <Field label="Website (optional)" error={form.formState.errors.website?.message}><Input placeholder="https://" {...form.register("website")} /></Field>
                  <Field label="Token image" hint="PNG, JPG or GIF. Kept local until a configured metadata upload is approved.">
                    <button type="button" className="upload-zone" onClick={() => toast.info("Metadata upload remains local until an IPFS provider is configured.")}><span><Upload size={19} /></span><strong>Upload image</strong><small>No file selected</small></button>
                  </Field>
                </div>
              ) : null}
              {step === 2 ? (
                <div className="form-section">
                  <div className="section-heading"><div><h2>Supply & route</h2><p>Choose the network-specific launch boundary.</p></div><CircleDollarSign size={22} /></div>
                  <div className="field-row">
                    <Field label="Decimals" error={form.formState.errors.decimals?.message}><Input type="number" {...form.register("decimals", { valueAsNumber: true })} /></Field>
                    <Field label="Initial supply" error={form.formState.errors.supply?.message}><Input {...form.register("supply")} /></Field>
                  </div>
                  <Field label={family === "solana" ? "Launch platform" : "Launch adapter"}><Select {...form.register("platform")}>{platformOptions.map((platform) => <option key={platform}>{platform}</option>)}</Select></Field>
                  <Field label="Token mode"><Select {...form.register("tokenMode")}>{family === "solana" ? <><option>Classic SPL</option><option>Token-2022 / Mayhem</option></> : <><option>No tax</option><option>Tax factory</option></>}</Select></Field>
                  <Field label={`Initial liquidity (${chain.nativeSymbol})`} hint="Zero never implies a live pool; deployment and first liquidity are verified separately."><Input inputMode="decimal" {...form.register("initialLiquidity")} /></Field>
                  <Panel className="boundary-note"><Info size={18} /><div><strong>Adapter truth</strong><p>{family === "solana" ? "Pump quote/buy construction is implemented. Other launchpads remain visibly unconfigured until their official interfaces are verified." : "Standard ERC-20 and Uniswap execution are separate from tax/CREATE2 factory behavior. Factory-specific modes require a verified address and simulation."}</p></div></Panel>
                </div>
              ) : null}
              {step === 3 ? (
                <div className="form-section">
                  <div className="section-heading"><div><h2>Controls</h2><p>Configure authorities, tax policy, and anti-sniper guardrails.</p></div><ShieldAlert size={22} /></div>
                  {family === "solana" ? (
                    <>
                      <Toggle checked={Boolean(values.revokeMintAuthority)} onCheckedChange={(value) => form.setValue("revokeMintAuthority", value)} label="Revoke mint authority after initial mint" description="Prevents additional supply after the confirmed mint transaction." />
                      <Toggle checked={Boolean(values.freezeAuthority)} onCheckedChange={(value) => form.setValue("freezeAuthority", value)} label="Enable freeze authority" description="Off by default. Requires an explicit operational justification." />
                      <Panel className="safe-replacement"><Sparkles size={18} /><div><strong>Anti-Sniper</strong><p>Threshold monitoring and bounded sell response are configured in Sniper; it never fabricates volume or market activity.</p></div></Panel>
                    </>
                  ) : (
                    <>
                      <Toggle checked={Boolean(values.taxEnabled)} onCheckedChange={(value) => form.setValue("taxEnabled", value, { shouldValidate: true })} label="Tax factory mode" description="Requires a configured, verified factory. Standard ERC-20 mode has no transfer tax." />
                      {values.taxEnabled ? (
                        <div className="tax-grid">
                          <Field label="Buy tax %"><Input type="number" step="0.01" {...form.register("buyTax", { valueAsNumber: true })} /></Field>
                          <Field label="Sell tax %"><Input type="number" step="0.01" {...form.register("sellTax", { valueAsNumber: true })} /></Field>
                          <Field label="Marketing BPS" error={form.formState.errors.marketingBps?.message}><Input type="number" {...form.register("marketingBps", { valueAsNumber: true })} /></Field>
                          <Field label="Reflections BPS"><Input type="number" {...form.register("reflectionsBps", { valueAsNumber: true })} /></Field>
                          <Field label="Burn BPS"><Input type="number" {...form.register("burnBps", { valueAsNumber: true })} /></Field>
                          <Field label="LP BPS"><Input type="number" {...form.register("liquidityBps", { valueAsNumber: true })} /></Field>
                          <div className="tax-total"><span>Distribution</span><strong>{taxTotal} / 10,000 BPS</strong></div>
                          <Field label="Tax duration (seconds)" error={form.formState.errors.taxDurationSeconds?.message}><Input type="number" {...form.register("taxDurationSeconds", { valueAsNumber: true })} /></Field>
                        </div>
                      ) : null}
                      <Field label="Anti-farmer duration (seconds)" hint="A transparent, time-bounded launch guard. No honeypot behavior."><Input type="number" {...form.register("antiFarmerSeconds", { valueAsNumber: true })} /></Field>
                      <Field label="CREATE2 salt (optional)" hint="Only a configured factory simulation can mark a preview address verified."><Input placeholder="bytes32 or phrase" {...form.register("create2Salt")} /></Field>
                    </>
                  )}
                </div>
              ) : null}
              {step === 4 ? (
                <div className="form-section">
                  <div className="section-heading"><div><h2>Review</h2><p>Confirm the exact manifest before any signature request.</p></div><FileCheck2 size={22} /></div>
                  <div className="review-manifest">
                    <div><span>Token</span><strong>{values.name || "—"} / {(values.symbol || "—").toUpperCase()}</strong></div>
                    <div><span>Network</span><strong>{chain.name}</strong></div>
                    <div><span>Adapter</span><strong>{values.platform}</strong></div>
                    <div><span>Mode</span><strong>{values.launchMode}</strong></div>
                    <div><span>Supply</span><strong>{values.supply} @ {values.decimals} decimals</strong></div>
                    <div><span>Custody</span><strong>Connected wallet signature</strong></div>
                    {family === "evm" ? <div><span>Tax / CREATE2</span><strong>{values.taxEnabled ? `${values.buyTax}% buy · ${values.sellTax}% sell` : "No tax"} / {values.create2Salt ? "requested" : "none"}</strong></div> : null}
                  </div>
                  <Panel className={adapterReady ? "readiness-card is-ready" : "readiness-card"}>
                    {adapterReady ? <Check size={19} /> : <ShieldAlert size={19} />}
                    <div><strong>{adapterReady ? "Fixed-supply adapter ready" : "Deployment adapter locked"}</strong><p>{adapterReady ? "Sepolia runs eth_call and estimateGas before the wallet is asked to deploy the immutable fixed-supply contract." : "The draft remains usable. No success state or token address is generated while the adapter is unavailable."}</p></div>
                  </Panel>
                </div>
              ) : null}
            </motion.div>
          </AnimatePresence>
          <div className="form-step-actions">
            <Button variant="ghost" disabled={step === 1} onClick={() => setStep((current) => Math.max(1, current - 1))}>Back</Button>
            <Button variant="secondary" disabled={step === 4} onClick={() => setStep((current) => Math.min(4, current + 1))}>Continue <ChevronRight size={16} /></Button>
          </div>
        </form>
        <aside className="preflight">
          <div className="preflight__head"><span>Preflight</span><Badge tone="good">Transparent</Badge></div>
          <div className="preflight__rows">
            <div><span>Network</span><strong>{chain.name}</strong></div>
            <div><span>Token standard</span><strong>{family === "solana" ? values.tokenMode : "ERC-20"}</strong></div>
            <div><span>Native unit</span><strong>{chain.nativeSymbol}</strong></div>
            <div><span>Authority</span><strong>{family === "solana" ? (values.revokeMintAuthority ? "Revoke after mint" : "Retained") : "Fixed supply"}</strong></div>
            <div><span>Metadata</span><strong>Local draft</strong></div>
            <div><span>Signer</span><strong>Browser wallet</strong></div>
          </div>
          <div className="cost-estimate"><span>Cost estimate</span><strong>RPC simulation required</strong><p>Sunder does not invent a fee estimate before a provider simulates the exact transaction.</p></div>
          <Panel className="preflight-lock"><ShieldAlert size={18} /><div><strong>{chain.production ? "Funded Mainnet locked" : adapterReady ? "Test adapter ready" : "Adapter unconfigured"}</strong><p>{chain.production ? "RPC, relay, signer policy, funding and operator confirmation must all pass." : "Devnet/Sepolia are the only automatic verification targets."}</p></div></Panel>
        </aside>
      </div>
      <div className="simulation-rail">
        <div className="simulation-rail__timeline">
          <div className="simulation-title"><span>Transaction simulation</span><Badge tone={simulation === "passed" ? "good" : simulation === "failed" ? "bad" : "neutral"}>{simulation === "running" ? "Running" : simulation === "passed" ? "Manifest passed" : simulation === "failed" ? "Fix errors" : "Not run"}</Badge></div>
          <div className="simulation-steps"><span><i>1</i>Build manifest<small>No signature</small></span><span><i>2</i>RPC simulation<small>Provider required</small></span><span><i>3</i>Confirm on-chain<small>Receipt required</small></span></div>
          <p><Info size={14} /> A local manifest pass is never reported as an on-chain launch.</p>
        </div>
        <div className="simulation-rail__actions">
          <div className="button-pair"><Button size="lg" onClick={() => void validateSimulation()} disabled={simulation === "running"}><Play size={17} /> Run validation</Button><Button size="lg" variant="primary" disabled={!fundedExecutionReady || simulation !== "passed" || ["simulating", "awaiting-signature", "submitted"].includes(evmLaunch.status.state)} onClick={() => void deploy()}><Rocket size={17} /> Deploy to {chain.production ? "Mainnet" : chain.name.replace("Solana ", "").replace("Ethereum ", "")}</Button></div>
          <div className="connection-warning"><ShieldAlert size={20} /><div><strong>{fundedExecutionReady ? "Wallet signature required" : "Execution is locked"}</strong><span>{evmLaunch.status.state !== "idle" ? evmLaunch.status.detail : fundedExecutionReady ? "The connected wallet must approve the exact simulated transaction." : adapterReady ? "Connect an EIP-1193 wallet for Sepolia deployment." : "Configure a verified adapter; no private-key upload is accepted."}</span></div><Button size="sm" onClick={explainReadiness}>Readiness</Button></div>
        </div>
      </div>
    </div>
  );
}
