const SOLANA_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isLikelySolanaMint(value: string): boolean {
  return SOLANA_MINT_PATTERN.test(value);
}

export function tokenMintFromPathname(pathname: string): string | undefined {
  const match = pathname.match(/^\/meme\/([^/?#]+)\/?$/);
  if (!match?.[1]) return undefined;
  try {
    const mint = decodeURIComponent(match[1]);
    return isLikelySolanaMint(mint) ? mint : undefined;
  } catch {
    return undefined;
  }
}

export function tokenTerminalPath(mint: string): string {
  if (!isLikelySolanaMint(mint)) throw new Error("A valid Solana mint is required for a token page.");
  return `/meme/${encodeURIComponent(mint)}?chain=sol`;
}
