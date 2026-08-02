import { describe, expect, it } from "vitest";
import { tokenMintFromPathname, tokenTerminalPath } from "../src/solana/token-route";

const MINT = "So11111111111111111111111111111111111111112";

describe("token terminal routes", () => {
  it("creates and parses a permanent Axiom-style token path", () => {
    expect(tokenTerminalPath(MINT)).toBe(`/meme/${MINT}?chain=sol`);
    expect(tokenMintFromPathname(`/meme/${MINT}`)).toBe(MINT);
    expect(tokenMintFromPathname(`/meme/${MINT}/`)).toBe(MINT);
  });

  it("rejects malformed or non-base58 token identifiers", () => {
    expect(tokenMintFromPathname("/meme/not-a-mint")).toBeUndefined();
    expect(tokenMintFromPathname("/swap")).toBeUndefined();
    expect(() => tokenTerminalPath("0x1234")).toThrow(/valid Solana mint/i);
  });
});
