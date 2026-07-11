import { makeClient, ccc } from "chain";
import { NETWORK, type Network } from "core";

export type GetChainClientFn = () => ccc.Client;
export type GetCustodialSignerFn = () => Promise<ccc.SignerCkbPrivateKey>;

let cachedClient: ccc.Client | null = null;

/**
 * A raw `ccc.Client`, lazily built so importing/testing this module never
 * opens a network connection by itself — same rationale as
 * `chainLookup.ts`'s `getClient()`. `/proofs/prepare|submit` and the
 * custodial routes need the real client (not just `fetchProof`/`getTip`),
 * since they call into `chain`'s tx builders and `sendTransaction`.
 */
export const defaultGetChainClient: GetChainClientFn = () => {
  cachedClient ??= makeClient();
  return cachedClient;
};

function truthyEnvFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * Whether custodial mode should be active for this process. Reads
 * `CUSTODIAL_ENABLED`; on mainnet, additionally refuses unless
 * `MAINNET_CONFIRM=1` is also set (TECHNICAL.md §9 / ClaudeCodeInstruction.md
 * global rules), logging a prominent warning instead of silently ignoring
 * the operator's request.
 */
export function resolveCustodialEnabled(
  network: Network = NETWORK,
  env: Record<string, string | undefined> | undefined = globalThis.process?.env,
): boolean {
  const requested = truthyEnvFlag(env?.CUSTODIAL_ENABLED);
  if (!requested) return false;
  if (network === "mainnet" && env?.MAINNET_CONFIRM !== "1") {
    // Fires before/without a configured logger — this is the earliest
    // point in startup that knows custodial mode was requested but denied.
    console.warn(
      "[vericell] CUSTODIAL_ENABLED is set but refusing to enable custodial mode on " +
        "mainnet without MAINNET_CONFIRM=1 — see TECHNICAL.md §9.",
    );
    return false;
  }
  return true;
}

let cachedSigner: Promise<ccc.SignerCkbPrivateKey> | null = null;

/**
 * Lazily built + connected service-wallet signer for custodial mode, cached
 * across requests. Throws (on first use, not at import time) if
 * `SERVICE_PRIVATE_KEY` isn't set — routes only call this once they've
 * already confirmed custodial mode is enabled.
 */
export const defaultGetCustodialSigner: GetCustodialSignerFn = () => {
  cachedSigner ??= (async () => {
    const privateKey = globalThis.process?.env?.SERVICE_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("CUSTODIAL_ENABLED requires SERVICE_PRIVATE_KEY to be set");
    }
    const signer = new ccc.SignerCkbPrivateKey(defaultGetChainClient(), privateKey);
    await signer.connect();
    return signer;
  })();
  return cachedSigner;
};
