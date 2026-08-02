import { expect, test, type Page } from "playwright/test";

async function selectEvm(page: Page, network: "evm:sepolia" | "evm:mainnet" = "evm:sepolia") {
  await page.getByRole("button", { name: "EVM", exact: true }).click();
  await page.getByRole("combobox", { name: "Network" }).selectOption(network);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(overflow.width, `scrollWidth ${overflow.width} exceeds viewport ${overflow.viewport}`).toBeLessThanOrEqual(overflow.viewport + 1);
}

async function installEvmWalletAndRpcMock(page: Page) {
  const account = "0x00000000000000000000000000000000000000a1";
  const transactionHash = `0x${"a".repeat(64)}`;
  const blockHash = `0x${"b".repeat(64)}`;
  const emptyBloom = `0x${"0".repeat(512)}`;
  let releaseReceipt: () => void = () => undefined;
  const receiptGate = new Promise<void>((resolve) => { releaseReceipt = resolve; });
  const state = {
    receiptReady: false,
    receiptCalls: 0,
    transactionCalls: 0,
    releaseReceipt() {
      this.receiptReady = true;
      releaseReceipt();
    },
  };

  await page.addInitScript(({ walletAccount, hash }) => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const provider = {
      isMetaMask: true,
      request: async ({ method }: { method: string; params?: readonly unknown[] }) => {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [walletAccount];
        if (method === "eth_chainId") return "0xaa36a7";
        if (method === "eth_getBalance") return "0x16345785d8a0000";
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "wallet_getCapabilities") return {};
        if (method === "eth_sendTransaction") {
          const tracker = window as typeof window & { __SUNDER_EVM_MOCK__?: { sendCount: number } };
          tracker.__SUNDER_EVM_MOCK__ = { sendCount: (tracker.__SUNDER_EVM_MOCK__?.sendCount ?? 0) + 1 };
          return hash;
        }
        throw new Error(`Unexpected wallet method: ${method}`);
      },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        const entries = listeners.get(event) ?? new Set();
        entries.add(listener);
        listeners.set(event, entries);
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => listeners.get(event)?.delete(listener),
    };
    Object.defineProperty(window, "ethereum", { configurable: true, value: provider });
  }, { walletAccount: account, hash: transactionHash });

  const quantity = (value: number) => `0x${value.toString(16)}`;
  const block = (number: number) => ({
    baseFeePerGas: quantity(1_000_000_000), difficulty: "0x0", extraData: "0x", gasLimit: quantity(30_000_000), gasUsed: quantity(21_000),
    hash: blockHash, logsBloom: emptyBloom, miner: "0x0000000000000000000000000000000000000000", mixHash: `0x${"0".repeat(64)}`,
    nonce: "0x0000000000000000", number: quantity(number), parentHash: `0x${"c".repeat(64)}`, receiptsRoot: `0x${"d".repeat(64)}`,
    sha3Uncles: `0x${"e".repeat(64)}`, size: quantity(1_000), stateRoot: `0x${"f".repeat(64)}`, timestamp: quantity(1_700_000_000),
    totalDifficulty: "0x0", transactions: [], transactionsRoot: `0x${"1".repeat(64)}`, uncles: [], withdrawals: [], withdrawalsRoot: `0x${"2".repeat(64)}`,
  });

  await page.route(/^https:\/\/.*/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    let payload: { id?: unknown; method?: string };
    try { payload = request.postDataJSON() as typeof payload; } catch { return route.continue(); }
    if (!payload.method) return route.continue();
    let result: unknown;
    switch (payload.method) {
      case "eth_call": result = "0x"; break;
      case "eth_estimateGas": result = "0x5208"; break;
      case "eth_maxPriorityFeePerGas": result = quantity(1_000_000_000); break;
      case "eth_gasPrice": result = quantity(2_000_000_000); break;
      case "eth_feeHistory": result = { oldestBlock: "0x64", baseFeePerGas: [quantity(1_000_000_000), quantity(1_100_000_000)], gasUsedRatio: [0.5], reward: [[quantity(1_000_000_000)]] }; break;
      case "eth_blockNumber": result = "0x66"; break;
      case "eth_getBalance": result = "0x16345785d8a0000"; break;
      case "eth_getTransactionReceipt":
        state.receiptCalls += 1;
        if (!state.receiptReady) await receiptGate;
        result = {
          blockHash, blockNumber: "0x64", contractAddress: null, cumulativeGasUsed: "0x5208", effectiveGasPrice: quantity(2_000_000_000),
          from: account, gasUsed: "0x5208", logs: [], logsBloom: emptyBloom, status: "0x1", to: account,
          transactionHash, transactionIndex: "0x0", type: "0x2",
        };
        break;
      case "eth_getBlockByNumber": result = block(100); break;
      case "eth_getTransactionByHash":
        state.transactionCalls += 1;
        result = {
          blockHash, blockNumber: "0x64", from: account, gas: "0x5208", gasPrice: quantity(2_000_000_000), hash: transactionHash,
          input: "0x", nonce: "0x1", to: account, transactionIndex: "0x0", value: "0x0", type: "0x2", chainId: "0xaa36a7",
          maxFeePerGas: quantity(3_000_000_000), maxPriorityFeePerGas: quantity(1_000_000_000), accessList: [],
          r: `0x${"1".repeat(64)}`, s: `0x${"2".repeat(64)}`, v: "0x1", yParity: "0x1",
        };
        break;
      default:
        if (!payload.method.startsWith("eth_")) return route.continue();
        throw new Error(`Unexpected public RPC method: ${payload.method}`);
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? 1, result }) });
  });
  return state;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/launch");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("heading", { name: "Launch Studio" })).toBeVisible();
});

test("all product routes are real application screens", async ({ page }) => {
  const routes = [
    ["dashboard", "Dashboard"],
    ["projects", "Projects"],
    ["wallets", "Wallets"],
    ["xid", "XID"],
    ["leaders", "Leaders"],
    ["launch", "Launch Studio"],
    ["sniper", "Sniper"],
    ["swap", "Swap Manager"],
    ["tracker", "Tracker"],
    ["settings", "Settings"],
    ["audit", "Audit Trail"],
    ["docs", "Docs"],
  ] as const;
  for (const [route, heading] of routes) {
    await page.goto(`/${route}`);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${route}$`));
  }
});

test("EVM launch, venue, fee and Mainnet lock states are truthful", async ({ page }) => {
  await selectEvm(page);
  await expect(page.getByText("ERC-20", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /Controls/ }).click();
  await page.getByRole("switch", { name: "Tax factory mode" }).click();
  await expect(page.getByLabel("Buy tax %")).toBeVisible();
  await expect(page.getByLabel(/CREATE2 salt/)).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByText(/private key|seed phrase/i)).toHaveCount(0);

  await page.goto("/sniper");
  await expect(page.getByLabel("Venue")).toContainText("Auto-detect V2/V3/V4");
  await expect(page.getByLabel(/Max fee per gas/)).toBeVisible();
  await expect(page.getByLabel("Health-weighted routing")).toHaveValue("rpc-protect");

  await page.goto("/launch");
  await page.getByRole("combobox", { name: "Network" }).selectOption("evm:mainnet");
  await expect(page.getByRole("button", { name: "Deploy to Mainnet" })).toBeDisabled();
  await expect(page.getByText("Execution is locked")).toBeVisible();
});

test("Sepolia wallet flow confirms only after canonical RPC receipt and signed intent verification", async ({ page }) => {
  const rpc = await installEvmWalletAndRpcMock(page);
  await page.reload();
  await selectEvm(page);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: /Connect (Injected|MetaMask)/ }).click();
  await expect(page.getByRole("dialog").getByText(/0x000…00a1/i)).toBeVisible();
  await page.getByRole("button", { name: "Verify on Sepolia" }).click();
  await expect(page.getByText("submitted", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open transaction in explorer/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open confirmed transaction/ })).toHaveCount(0);
  await expect(page.getByText("confirmed", { exact: true })).toHaveCount(0);
  rpc.releaseReceipt();
  await expect(page.getByText("confirmed", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Canonical receipt and self-transfer intent verified/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Open confirmed transaction/ })).toBeVisible();
  await expect(page.getByText("Sepolia verification confirmed by canonical receipt.")).toBeVisible();
  expect(rpc.receiptCalls).toBe(1);
  expect(rpc.transactionCalls).toBe(1);
  await expect(page.evaluate(() => (window as typeof window & { __SUNDER_EVM_MOCK__?: { sendCount: number } }).__SUNDER_EVM_MOCK__?.sendCount)).resolves.toBe(1);
});

test("selected family persists and closed navigation drawer is inert", async ({ page }, testInfo) => {
  await selectEvm(page);
  await page.reload();
  await expect(page.getByRole("button", { name: "EVM", exact: true })).toHaveAttribute("aria-pressed", "true");
  const drawer = page.locator("#workspace-drawer");
  await expect(drawer).toHaveAttribute("inert", "");
  await expect(drawer).toHaveAttribute("aria-hidden", "true");
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  if (testInfo.project.name === "mobile") {
    await toggle.click();
    await expect(drawer).not.toHaveAttribute("inert", "");
    await expect(drawer).toHaveAttribute("aria-hidden", "false");
  } else {
    await expect(toggle).toBeHidden();
  }
});

test("desktop console matches dense source composition", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop evidence only");
  await page.screenshot({ path: "artifacts/qa/final-desktop-launch.png", fullPage: true });
  await expectNoHorizontalOverflow(page);
});

test("terminal panels drag, persist, and expose live candlestick controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop interaction evidence only");
  await page.goto("/swap");
  const trade = page.locator(".terminal-floating-panel--trade");
  const wallets = page.locator(".terminal-floating-panel--wallets");
  const handle = trade.locator(".terminal-floating-panel__handle");
  await expect(trade).toBeVisible();
  await expect(wallets).toBeVisible();
  await expect(page.getByRole("button", { name: "1s" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Charting by TradingView" })).toBeVisible();
  await expect(page.getByLabel("Slippage percent")).toHaveValue("1");

  const before = await trade.boundingBox();
  const handleBox = await handle.boundingBox();
  expect(before).not.toBeNull();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + 70, handleBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + 210, handleBox!.y + 90, { steps: 6 });
  await page.mouse.up();
  const moved = await trade.boundingBox();
  expect(moved!.x).toBeGreaterThan(before!.x + 100);
  expect(moved!.y).toBeGreaterThan(before!.y + 40);
  await page.reload();
  const restored = await trade.boundingBox();
  expect(restored!.x).toBeCloseTo(moved!.x, 0);
  expect(restored!.y).toBeCloseTo(moved!.y, 0);
});

test("all mobile product routes stay within the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile evidence only");
  for (const route of ["dashboard", "projects", "wallets", "xid", "leaders", "launch", "sniper", "swap", "tracker", "settings", "audit", "docs"] as const) {
    await page.goto(`/${route}`);
    await expectNoHorizontalOverflow(page);
    if (route === "swap") {
      await expect(page.locator(".terminal-workspace")).toBeVisible();
      await expect(page.locator(".terminal-floating-layer")).toBeVisible();
      await expect(page.locator(".terminal-floating-panel--trade")).toBeVisible();
      await expect(page.locator(".terminal-floating-panel--wallets")).toBeVisible();
      const terminalFlow = await page.evaluate(() => {
        const workspace = document.querySelector<HTMLElement>(".terminal-workspace");
        const layer = document.querySelector<HTMLElement>(".terminal-floating-layer");
        if (!workspace || !layer) throw new Error("Trading terminal layout is missing.");
        const workspaceBox = workspace.getBoundingClientRect();
        const layerBox = layer.getBoundingClientRect();
        return {
          workspaceBottom: workspaceBox.bottom + window.scrollY,
          dockTop: layerBox.top + window.scrollY,
        };
      });
      expect(terminalFlow.dockTop).toBeGreaterThanOrEqual(terminalFlow.workspaceBottom - 1);
    }
  }
  await page.goto("/sniper");
  await selectEvm(page);
  await page.screenshot({ path: "artifacts/qa/final-mobile-sniper-evm.png", fullPage: true });
});
