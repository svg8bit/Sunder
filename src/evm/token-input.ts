export function validateTokenDecimals(decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Token decimals must be an integer from 0 to 255.");
  }
  return decimals;
}
