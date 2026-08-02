import { resolve } from "node:path";
import { z } from "zod";

const requiredPath = z.string().min(1).transform((value) => resolve(value));

const schema = z.object({
  SUNDER_SIGNER_SOCKET: requiredPath,
  SUNDER_SIGNER_KEYSTORE_FILE: requiredPath,
  SUNDER_SIGNER_KEK_FILE: requiredPath,
  SUNDER_SIGNER_POLICY_FILE: requiredPath,
});

export interface SignerConfig {
  readonly socketPath: string;
  readonly keystoreFile: string;
  readonly kekFile: string;
  readonly policyFile: string;
}

export function parseSignerConfig(environment: NodeJS.ProcessEnv = process.env): SignerConfig {
  const forbidden = Object.keys(environment).filter((name) =>
    name.startsWith("SUNDER_") && /(?:PRIVATE[_-]?KEY|SEED|MNEMONIC|SECRET[_-]?KEY)/i.test(name),
  );
  if (forbidden.length > 0) {
    throw new Error(`Forbidden key-material environment variables detected: ${forbidden.join(", ")}.`);
  }
  const parsed = schema.parse(environment);
  return Object.freeze({
    socketPath: parsed.SUNDER_SIGNER_SOCKET,
    keystoreFile: parsed.SUNDER_SIGNER_KEYSTORE_FILE,
    kekFile: parsed.SUNDER_SIGNER_KEK_FILE,
    policyFile: parsed.SUNDER_SIGNER_POLICY_FILE,
  });
}
