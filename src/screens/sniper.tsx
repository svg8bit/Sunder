import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Check, CircleDot, ClipboardCopy, Crosshair, Info, LockKeyhole, Play, Route, Shield, ShieldCheck, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Badge, Button, Field, Input, Panel, Segmented, Select, Toggle } from "../components/ui";
import { useNetwork } from "../state/network";
import { useWorkspace } from "../state/workspace";

const sniperSchema = z.object({
  trigger: z.enum(["manual", "new_mint", "pool_created", "x_post", "program_log"]),
  target: z.string().trim().min(4, "Enter a token mint or contract address."),
  inputToken: z.string().trim(),
  maxSpend: z.number().positive().max(1_000),
  slippage: z.number().positive().max(50),
  priceImpact: z.number().positive().max(50),
  priorityFee: z.number().min(0),
  maxFee: z.number().min(0),
  tip: z.number().min(0),
  cooldown: z.number().int().min(0).max(86_400),
  maxAttempts: z.number().int().min(1).max(10),
  maxConfirmedExecutions: z.number().int().min(1).max(3),
  relay: z.string(),
  venue: z.enum(["auto", "v2", "v3", "v4"]),
  executionMode: z.enum(["single", "multi"]),
  pretradeSimulation: z.boolean(),
  requireMedia: z.boolean(),
  antiSniper: z.boolean(),
  thresholdPercent: z.number().min(0).max(100),
  monitorDuration: z.number().int().min(1).max(600),
  stopMode: z.enum(["first_success", "bounded_all"]),
});

type SniperForm = z.infer<typeof sniperSchema>;

function RelayCard({ name, kind, configured, note }: { readonly name: string; readonly kind: string; readonly configured: boolean; readonly note: string }) {
  return (
    <div className="relay-card">
      <div><span className={configured ? "relay-dot is-ready" : "relay-dot"} /><strong>{name}</strong></div>
      <span>{kind}</span>
      <b>{configured ? "Ready" : "Unconfigured"}</b>
      <small>{note}</small>
    </div>
  );
}

export function SniperScreen() {
  const { family, network, chain } = useNetwork();
  const workspace = useWorkspace();
  const [simulationState, setSimulationState] = useState<"idle" | "passed" | "failed">("idle");
  const [advanced, setAdvanced] = useState(false);
  const form = useForm<SniperForm>({
    resolver: zodResolver(sniperSchema),
    mode: "onChange",
    defaultValues: {
      trigger: "new_mint",
      target: family === "solana" ? "So11111111111111111111111111111111111111112" : "0x0000000000000000000000000000000000000000",
      inputToken: family === "solana" ? "SOL" : "WETH",
      maxSpend: family === "solana" ? 0.001 : 0.01,
      slippage: 1,
      priceImpact: 2,
      priorityFee: family === "solana" ? 0.0000125 : 1.5,
      maxFee: family === "evm" ? 35 : 0,
      tip: family === "solana" ? 0.000001 : 0,
      cooldown: 30,
      maxAttempts: 3,
      maxConfirmedExecutions: 3,
      relay: family === "solana" ? "health-weighted" : "rpc-protect",
      venue: "auto",
      executionMode: "single",
      pretradeSimulation: true,
      requireMedia: false,
      antiSniper: false,
      thresholdPercent: 10,
      monitorDuration: 30,
      stopMode: "first_success",
    },
  });
  const values = useWatch({ control: form.control });
  const executionMode = values.executionMode ?? "single";
  const mainnetLocked = chain.production;

  useEffect(() => {
    form.setValue("target", family === "solana" ? "So11111111111111111111111111111111111111112" : "0x0000000000000000000000000000000000000000", { shouldValidate: true });
    form.setValue("inputToken", family === "solana" ? "SOL" : "WETH");
    form.setValue("maxSpend", family === "solana" ? 0.001 : 0.01, { shouldValidate: true });
    form.setValue("priorityFee", family === "solana" ? 0.0000125 : 1.5, { shouldValidate: true });
    form.setValue("maxFee", family === "evm" ? 35 : 0, { shouldValidate: true });
    form.setValue("tip", family === "solana" ? 0.000001 : 0, { shouldValidate: true });
    form.setValue("relay", family === "solana" ? "health-weighted" : "rpc-protect");
    setSimulationState("idle");
  }, [family, form]);

  const simulate = form.handleSubmit((data) => {
    if (!data.pretradeSimulation) {
      setSimulationState("failed");
      toast.error("Pre-trade simulation is mandatory in Sunder.");
      return;
    }
    setSimulationState("passed");
    workspace.record({
      category: "simulation",
      action: "Sniper rule dry-run passed",
      detail: `${data.trigger} → ${data.target.slice(0, 12)}…; quote and transaction were not submitted.`,
      state: "passed",
      network,
    });
    toast.success("Rule dry-run passed. Live quote remains provider-gated.");
  }, () => {
    setSimulationState("failed");
    toast.error("Resolve the rule errors before simulation.");
  });

  const arm = form.handleSubmit((data) => {
    const externallyArmed = mainnetLocked && executorAcceptanceArmed;
    workspace.record({
      category: "configuration",
      action: externallyArmed ? "External Mainnet acceptance policy inspected" : mainnetLocked ? "Mainnet sniper remained locked" : "Sniper dry-run armed locally",
      detail: externallyArmed
        ? "The isolated one-shot operator policy is already armed; this browser form cannot mutate its signer or funding controls."
        : mainnetLocked
        ? executorProvisioned
          ? "The isolated executor is provisioned; funding and immediate operator confirmation remain."
          : "Funded execution requires executor signer, RPC, relay, limits, funding and operator confirmation."
        : `${data.trigger} rule saved in dry-run mode; no persistent executor is connected.`,
      state: externallyArmed ? "local" : mainnetLocked ? "locked" : "local",
      network,
    });
    if (externallyArmed) toast.success("The bounded operator acceptance policy is already armed outside Vercel.");
    else toast.warning(mainnetLocked ? executorProvisioned ? "Executor is provisioned; its remaining runtime gates must pass outside Vercel." : "Persistent Mainnet sniper execution is locked by policy; manual wallet swaps remain separate." : "Dry-run armed locally. Persistent executor is unconfigured.");
  });

  const solanaRelayConfig = {
    jito: Boolean(import.meta.env.VITE_JITO_STATUS_ENDPOINT),
    nozomi: Boolean(import.meta.env.VITE_NOZOMI_STATUS_ENDPOINT),
    zeroSlot: Boolean(import.meta.env.VITE_ZERO_SLOT_STATUS_ENDPOINT),
  };
  const executorAddress = family === "solana" ? import.meta.env.VITE_SOLANA_EXECUTOR_PUBLIC_ADDRESS?.trim() : undefined;
  const executorProvisioned = Boolean(executorAddress);
  const executorAcceptanceArmed = family === "solana" && import.meta.env.VITE_SOLANA_EXECUTOR_POLICY_STATE === "acceptance-armed";
  const copyExecutorAddress = async () => {
    if (!executorAddress) return;
    await navigator.clipboard.writeText(executorAddress);
    toast.success("Executor funding address copied.");
  };

  return (
    <div className="screen sniper-screen">
      <div className="screen-heading">
        <div><span className="eyebrow">P0 execution pipeline / {family.toUpperCase()}</span><h1>Sniper</h1><p>Rules, risk, simulation, relays and canonical confirmation in one bounded path.</p></div>
        <div className="heading-actions"><Badge tone={executorAcceptanceArmed ? "good" : mainnetLocked ? "warn" : "good"}>{executorAcceptanceArmed ? "Acceptance armed" : mainnetLocked ? executorProvisioned ? "Runtime gates" : "Persistent executor locked" : "Test mode"}</Badge><Button size="sm" onClick={() => setAdvanced((current) => !current)}>{advanced ? "Basic controls" : "Advanced controls"}</Button></div>
      </div>
      <div className="sniper-layout">
        <form className="sniper-form" onSubmit={(event) => event.preventDefault()}>
          <Panel title="Trigger" action={<Badge tone="accent"><Zap size={12} /> Normalized event</Badge>}>
            <Field label="Event source"><Select {...form.register("trigger")}><option value="new_mint">New token launch</option><option value="pool_created">Pool created</option><option value="program_log">Program / contract log</option><option value="x_post">XID post</option><option value="manual">Manual test event</option></Select></Field>
            <Field label={family === "solana" ? "Target mint" : "Target token contract"} hint={family === "solana" ? "Solana mint address or symbol" : "Checksummed 0x token address"} error={form.formState.errors.target?.message} valid={!form.formState.errors.target && Boolean(values.target)}><Input {...form.register("target")} /></Field>
            {family === "evm" ? <div className="field-row"><Field label="Input token"><Input {...form.register("inputToken")} /></Field><Field label="Venue"><Select {...form.register("venue")}><option value="auto">Auto-detect V2/V3/V4</option><option value="v2">Uniswap V2</option><option value="v3">Uniswap V3</option><option value="v4">Uniswap V4</option></Select></Field></div> : null}
          </Panel>
          <Panel title="Risk & fees" action={<ShieldCheck size={17} />}>
            <div className="field-row">
              <Field label="Max spend" hint={`Maximum ${chain.nativeSymbol} per execution`} error={form.formState.errors.maxSpend?.message}><div className="input-unit"><Input type="number" step="0.0001" {...form.register("maxSpend", { valueAsNumber: true })} /><span>{chain.nativeSymbol}</span></div></Field>
              <Field label="Slippage tolerance" error={form.formState.errors.slippage?.message}><div className="input-unit"><Input type="number" step="0.1" {...form.register("slippage", { valueAsNumber: true })} /><span>%</span></div></Field>
            </div>
            {family === "solana" ? (
              <div className="field-row"><Field label="Priority fee"><div className="input-unit"><Input type="number" step="0.0000001" {...form.register("priorityFee", { valueAsNumber: true })} /><span>SOL</span></div></Field><Field label="Relay tip"><div className="input-unit"><Input type="number" step="0.000001" {...form.register("tip", { valueAsNumber: true })} /><span>SOL</span></div></Field></div>
            ) : (
              <div className="field-row"><Field label="Max fee per gas"><div className="input-unit"><Input type="number" step="0.1" {...form.register("maxFee", { valueAsNumber: true })} /><span>Gwei</span></div></Field><Field label="Priority fee"><div className="input-unit"><Input type="number" step="0.1" {...form.register("priorityFee", { valueAsNumber: true })} /><span>Gwei</span></div></Field></div>
            )}
            <div className="field-row"><Field label="Cooldown"><div className="input-unit"><Input type="number" {...form.register("cooldown", { valueAsNumber: true })} /><span>s</span></div></Field><Field label="Attempt budget"><Input type="number" {...form.register("maxAttempts", { valueAsNumber: true })} /></Field></div>
            <Field label="Canonical entry cap" hint="Stops this armed rule after the first 1–3 RPC-confirmed executions." error={form.formState.errors.maxConfirmedExecutions?.message}><Input type="number" min="1" max="3" {...form.register("maxConfirmedExecutions", { valueAsNumber: true })} /></Field>
          </Panel>
          <Panel title="Relay strategy" action={<Route size={17} />}>
            <Field label="Health-weighted routing"><Select {...form.register("relay")}>{family === "solana" ? <><option value="health-weighted">RPC + configured private relays</option><option value="rpc-only">Standard RPC only</option><option value="jito-primary">Jito primary</option></> : <><option value="rpc-protect">RPC + Flashbots Protect</option><option value="rpc-only">Standard RPC only</option><option value="flashbots-private">Private transaction adapter</option></>}</Select></Field>
            <Segmented value={executionMode} onChange={(value) => form.setValue("executionMode", value)} ariaLabel="Execution mode" options={[{ value: "single", label: "Single shot" }, { value: "multi", label: "Multi-shot" }]} />
            <p className="field__hint">Multi-shot preserves EVM nonce for fee replacement or refreshes a Solana blockhash only after expiry.</p>
          </Panel>
          <Panel title="Safety checks" action={<Shield size={17} />}>
            <Toggle checked={Boolean(values.pretradeSimulation)} onCheckedChange={(value) => form.setValue("pretradeSimulation", value)} label="Enable pre-trade simulation" description="Mandatory before signing; relay preflight settings do not replace it." />
            <Toggle checked={Boolean(values.requireMedia)} onCheckedChange={(value) => form.setValue("requireMedia", value)} label="Require media on XID events" description="Events without media fail deterministic rule evaluation." />
            <Toggle checked={Boolean(values.antiSniper)} onCheckedChange={(value) => form.setValue("antiSniper", value)} label="Anti-Sniper" description="Monitor a bounded window and stop after an explicitly confirmed response." />
            {values.antiSniper ? <div className="anti-sniper-grid"><Field label="Threshold %"><Input type="number" {...form.register("thresholdPercent", { valueAsNumber: true })} /></Field><Field label="Monitor duration"><div className="input-unit"><Input type="number" {...form.register("monitorDuration", { valueAsNumber: true })} /><span>s</span></div></Field><Field label="Stop mode"><Select {...form.register("stopMode")}><option value="first_success">First confirmed success</option><option value="bounded_all">Bounded attempt budget</option></Select></Field></div> : null}
          </Panel>
          {advanced ? <Panel title="Shared core invariants"><div className="invariant-grid"><span><Check size={14} /> Event cursor dedupe</span><span><Check size={14} /> Stale quote rejection</span><span><Check size={14} /> Daily spend limit</span><span><Check size={14} /> Kill switch</span><span><Check size={14} /> Idempotency key</span><span><Check size={14} /> Audit timestamps</span></div></Panel> : null}
        </form>
        <aside className="sniper-sidebar">
          <Panel title="Pipeline" action={<Badge tone="good">Independent package</Badge>}>
            <div className="pipeline-list">
              {["EventSource", "RuleEvaluator", "QuoteAdapter", "TransactionAdapter", "Simulator", "WalletAdapter", "RelayRouter", "ConfirmationAdapter", "RetryController", "RiskEngine", "AuditSink"].map((stage, index) => <div key={stage}><i>{index + 1}</i><span>{stage}</span>{index < 10 ? <ArrowRight size={13} /> : <Check size={13} />}</div>)}
            </div>
          </Panel>
          <Panel title="Relay & readiness" action={<span className="updated-label"><CircleDot size={12} /> Live config</span>}>
            <div className="relay-grid">
              <RelayCard name="Standard RPC" kind={family === "solana" ? "sendTransaction" : "eth_sendRawTransaction"} configured note="No synthetic latency" />
              {family === "solana" ? <><RelayCard name="Jito" kind="Block Engine" configured={solanaRelayConfig.jito} note="Own simulation required" /><RelayCard name="Nozomi" kind="Temporal" configured={solanaRelayConfig.nozomi} note="HTTP 200 is not confirmation" /><RelayCard name="0slot" kind="Low latency" configured={solanaRelayConfig.zeroSlot} note="Credential required" /></> : <><RelayCard name="Flashbots Protect" kind="Protected RPC" configured note="Receipt still required" /><RelayCard name="Private tx" kind="Auth signer" configured={false} note="Server-only X-Flashbots-Signature" /></>}
            </div>
          </Panel>
          <Panel className="honesty-panel"><Info size={18} /><div><strong>No false success</strong><p>A relay response, predicted token address, or local simulation cannot produce a green execution state. Only a canonical signature/receipt does.</p></div></Panel>
          <Panel title="Current status">
            <div className="status-list"><div><span>Rule</span><Badge tone={form.formState.isValid ? "good" : "warn"}>{form.formState.isValid ? "Valid" : "Incomplete"}</Badge></div><div><span>Simulation</span><Badge tone={simulationState === "passed" ? "good" : simulationState === "failed" ? "bad" : "neutral"}>{simulationState}</Badge></div><div><span>Executor</span><Badge tone={executorProvisioned ? "good" : "warn"}>{executorProvisioned ? "Provisioned" : "Unconfigured"}</Badge></div><div><span>Persistent Mainnet</span><Badge tone={executorAcceptanceArmed ? "good" : "warn"}>{executorAcceptanceArmed ? "One-shot armed" : "Runtime-gated"}</Badge></div></div>
            {executorAddress ? <div className="keys-note"><ShieldCheck size={14} /><span>Dedicated bounded wallet: {executorAddress.slice(0, 6)}…{executorAddress.slice(-6)}</span><Button type="button" size="sm" variant="ghost" onClick={() => void copyExecutorAddress()}><ClipboardCopy size={13} /> Copy</Button></div> : null}
          </Panel>
        </aside>
      </div>
      <div className="sniper-actionbar">
        <div className="environment-warning"><LockKeyhole size={20} /><div><strong>{chain.production ? `Persistent automation on ${chain.name}` : `Safe verification on ${chain.name}`}</strong><span>{chain.production ? executorAcceptanceArmed ? "A separate bounded operator policy is armed for one 0.001 SOL SUNDER-keyword Pump launch. Only canonical RPC confirmation counts; this browser cannot change the signer policy." : executorProvisioned ? "The isolated executor is provisioned, but Vercel cannot attest its live funding, signer or operator gates." : "The executor stays locked until signer, RPC, relay, limits, funding and operator gates pass. Manual browser swaps remain separately user-signed." : "Dry-run and wallet verification are available; no persistent signer is connected."}</span></div></div>
        <div className="button-pair"><Button size="lg" onClick={() => void simulate()}><Play size={18} /> Run simulation</Button><Button size="lg" variant="primary" onClick={() => void arm()}><Crosshair size={18} /> {executorAcceptanceArmed ? "View armed policy" : chain.production ? "Check Mainnet gates" : "Arm dry-run"}</Button></div>
        <div className="keys-note"><ShieldCheck size={14} /> Your keys never enter Sunder. Browser wallets sign interactive transactions; the executor uses a separate signer policy.</div>
      </div>
    </div>
  );
}
