import { describe, expect, it } from "vitest";
import { encodeDeployData } from "viem";
import { SUNDER_FIXED_SUPPLY_TOKEN_ABI, SUNDER_FIXED_SUPPLY_TOKEN_BYTECODE } from "../src/evm/generated/sunder-fixed-supply-token";
import { validateTokenDecimals } from "../src/evm/token-input";

describe("SunderFixedSupplyToken artifact", () => {
  it("encodes a deterministic fixed-supply ERC-20 deployment", () => {
    const recipient = "0x0000000000000000000000000000000000000001";
    const data = encodeDeployData({
      abi: SUNDER_FIXED_SUPPLY_TOKEN_ABI,
      bytecode: SUNDER_FIXED_SUPPLY_TOKEN_BYTECODE,
      args: ["Sunder Test", "SNDR", 18, 1_000_000n * 10n ** 18n, recipient],
    });
    expect(data.startsWith(SUNDER_FIXED_SUPPLY_TOKEN_BYTECODE)).toBe(true);
    expect(data.length).toBeGreaterThan(SUNDER_FIXED_SUPPLY_TOKEN_BYTECODE.length);
  });

  it("exposes no owner, mint, tax, blacklist, pause, or upgrade function", () => {
    const functions = SUNDER_FIXED_SUPPLY_TOKEN_ABI
      .filter((item) => item.type === "function")
      .map((item) => item.name);
    expect(functions).toEqual(expect.arrayContaining(["name", "symbol", "decimals", "totalSupply", "balanceOf", "allowance", "transfer", "approve", "transferFrom"]));
    for (const forbidden of ["owner", "mint", "tax", "blacklist", "pause", "upgradeTo"]) {
      expect(functions).not.toContain(forbidden);
    }
  });

  it("rejects decimals that cannot be encoded as the constructor uint8", () => {
    expect(validateTokenDecimals(0)).toBe(0);
    expect(validateTokenDecimals(255)).toBe(255);
    for (const invalid of [-1, 1.5, 256, Number.NaN]) {
      expect(() => validateTokenDecimals(invalid)).toThrow(/integer from 0 to 255/);
    }
  });
});
