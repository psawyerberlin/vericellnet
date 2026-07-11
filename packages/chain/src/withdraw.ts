import { ccc } from "@ckb-ccc/ccc";
import { DEFAULT_FEE_RATE } from "./constants.js";
import { reserveSighashWitness } from "./witness.js";

export interface BuildWithdrawTxParams {
  client: ccc.Client;
  /** Lock script of the cell's owner — capacity refunds here. */
  lock: ccc.ScriptLike;
  /** Out point of the live proof cell to withdraw. */
  outPoint: ccc.OutPointLike;
  feeRate?: ccc.NumLike;
}

/**
 * Build an unsigned withdraw transaction: consumes the proof cell without a
 * successor output. `completeFeeBy` turns the consumed cell's capacity
 * (minus fee) into a single change output back to `lock` — no other inputs
 * are needed since the consumed cell alone covers the fee many times over.
 */
export async function buildWithdrawTx(params: BuildWithdrawTxParams): Promise<ccc.Transaction> {
  const { client, lock, outPoint, feeRate } = params;

  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: outPoint }],
  });

  const signer = new ccc.SignerCkbScriptReadonly(client, lock);
  await reserveSighashWitness(tx, lock, client);
  await tx.completeFeeBy(signer, feeRate ?? DEFAULT_FEE_RATE);

  return tx;
}
