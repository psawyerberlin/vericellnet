import { readFileSync } from "node:fs";
import { ccc } from "@ckb-ccc/ccc";
import { NETWORK, type Network } from "core";

const DEFAULT_DEVNET_RPC_URL = "http://127.0.0.1:28114";

/**
 * A devnet's system scripts (Secp256k1Blake160, TypeId, ...) are deployed in
 * its own genesis block, so their cell-dep out points differ from every
 * other devnet and from testnet/mainnet — unlike TypeId (a native VM
 * feature, identical everywhere), signing depends on getting these right.
 * Point `VERICELL_DEVNET_SCRIPTS_FILE` at the JSON produced by
 * `offckb system-scripts --export-style ccc -o <file>` for the running
 * devnet to fix this up; without it, devnet falls back to testnet's
 * scripts, which is wrong for anything except TypeId.
 */
function devnetScripts(): Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined> | undefined {
  const path = globalThis.process?.env?.VERICELL_DEVNET_SCRIPTS_FILE;
  if (!path) return undefined;
  // Produced by `offckb system-scripts --export-style ccc -o <file>`.
  // Usually only a subset of KnownScript is present — getKnownScript throws
  // a clear error for any script this devnet's fixture doesn't cover.
  return JSON.parse(readFileSync(path, "utf8")) as Record<
    ccc.KnownScript,
    ccc.ScriptInfoLike | undefined
  >;
}

/**
 * Build a CCC client for the given network. Devnet's RPC URL is read from
 * `VERICELL_DEVNET_RPC_URL` (defaults to offckb's local node).
 *
 * The `network` parameter exists only so tests can pin a network without
 * touching process.env; every other caller should call this with no
 * argument and let it resolve from `core`'s NETWORK constant.
 */
export function makeClient(network: Network = NETWORK): ccc.Client {
  switch (network) {
    case "mainnet":
      return new ccc.ClientPublicMainnet();
    case "testnet":
      return new ccc.ClientPublicTestnet();
    case "devnet": {
      const url = globalThis.process?.env?.VERICELL_DEVNET_RPC_URL ?? DEFAULT_DEVNET_RPC_URL;
      return new ccc.ClientPublicTestnet({ url, scripts: devnetScripts() });
    }
  }
}
