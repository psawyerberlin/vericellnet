import { ccc } from "@ckb-ccc/ccc";
import { decodeManifest, type Manifest } from "core";

export interface ProofResult {
  manifest: Manifest | null;
  /** true = live (unspent), false = consumed, null = lookup failed/unknown. */
  live: boolean | null;
  blockNumber: bigint | null;
  blockTime: Date | null;
  ownerAddress: string | null;
}

const EMPTY_PROOF: ProofResult = {
  manifest: null,
  live: null,
  blockNumber: null,
  blockTime: null,
  ownerAddress: null,
};

/**
 * Fetch a proof cell's manifest and chain status by its creating tx hash and
 * output index. Mirrors the v1 web app's `fetchProofFromChain`, now shared.
 */
export async function fetchProof(
  client: ccc.Client,
  txHash: ccc.HexLike,
  index: ccc.NumLike = 0,
): Promise<ProofResult> {
  const out: ProofResult = { ...EMPTY_PROOF };

  const res = await client.getTransaction(txHash);
  if (!res) {
    return out;
  }

  const output = res.transaction.getOutput(index);
  if (output && output.outputData !== "0x") {
    try {
      out.manifest = decodeManifest(ccc.bytesFrom(output.outputData));
    } catch {
      // not a valid VeriCell manifest
    }
  }

  if (output) {
    out.ownerAddress = ccc.Address.fromScript(output.cellOutput.lock, client).toString();
  }

  if (res.blockHash) {
    const header = await client.getHeaderByHash(res.blockHash);
    if (header) {
      out.blockNumber = header.number;
      out.blockTime = new Date(Number(header.timestamp));
    }
  }

  try {
    const cell = await client.getCellLive({ txHash, index }, false);
    out.live = !!cell;
  } catch {
    out.live = false;
  }

  return out;
}
