import { ccc } from "@ckb-ccc/ccc";
import { DEFAULT_FEE_RATE } from "./constants.js";
import { reserveSighashWitness } from "./witness.js";

export interface BuildAnchorTxParams {
  client: ccc.Client;
  lock: ccc.ScriptLike;
  manifestBytes: ccc.BytesLike;
  /** Out point of the previous version's cell, if this anchors a new version. */
  prevOutPoint?: ccc.OutPointLike;
  feeRate?: ccc.NumLike;
}

/**
 * Build an unsigned anchor transaction: one output cell (auto minimum
 * capacity) carrying `manifestBytes` as its data, locked to `lock`.
 * If `prevOutPoint` is given, that cell is consumed as the transaction's
 * first input (the v1, no-Type-ID versioning scheme: the new tx hash
 * becomes the version's identity, `prev` links it to the old one).
 *
 * Capacity and fee are completed against `lock` alone (no signing key
 * required), so this same builder serves both a locally-connected signer
 * and a server that only knows the payer's lock (the non-custodial
 * `/proofs/prepare` flow).
 */
export async function buildAnchorTx(params: BuildAnchorTxParams): Promise<ccc.Transaction> {
  const { client, lock, manifestBytes, prevOutPoint, feeRate } = params;

  const tx = ccc.Transaction.from({
    inputs: prevOutPoint ? [{ previousOutput: prevOutPoint }] : [],
    outputs: [{ lock }],
    outputsData: [manifestBytes],
  });

  const signer = new ccc.SignerCkbScriptReadonly(client, lock);
  await tx.completeInputsByCapacity(signer);
  await reserveSighashWitness(tx, lock, client);
  await tx.completeFeeBy(signer, feeRate ?? DEFAULT_FEE_RATE);

  return tx;
}

export interface BuildAnchorTxWithTypeIdParams {
  client: ccc.Client;
  lock: ccc.ScriptLike;
  manifestBytes: ccc.BytesLike;
  /**
   * Out point of the previous version's cell. When set, this is an update:
   * `prevTypeScript` is required and is carried over unchanged (Type ID
   * args are stable for the lifetime of the project).
   */
  prevOutPoint?: ccc.OutPointLike;
  prevTypeScript?: ccc.ScriptLike;
  feeRate?: ccc.NumLike;
}

export interface AnchorTxWithTypeId {
  tx: ccc.Transaction;
  /** Type ID args: the project's stable UNID. */
  typeId: ccc.Hex;
}

/**
 * Same as {@link buildAnchorTx}, but the output cell carries a Type ID type
 * script so the project has a stable identifier across versions.
 *
 * First version: the Type ID args are computed via `ccc.hashTypeId` from the
 * transaction's first input and the output's index, per TECHNICAL.md §5 —
 * this requires at least one input, so one is collected even if the output
 * capacity would otherwise be covered by nothing (`completeInputsAtLeastOne`).
 *
 * Update (prevOutPoint set): the previous cell's type script is reused
 * as-is, so the args (and therefore the project's UNID) never change.
 */
export async function buildAnchorTxWithTypeId(
  params: BuildAnchorTxWithTypeIdParams,
): Promise<AnchorTxWithTypeId> {
  const { client, lock, manifestBytes, prevOutPoint, prevTypeScript, feeRate } = params;

  if (prevOutPoint && !prevTypeScript) {
    throw new Error("buildAnchorTxWithTypeId: prevTypeScript is required when prevOutPoint is set");
  }

  const tx = ccc.Transaction.from({
    inputs: prevOutPoint ? [{ previousOutput: prevOutPoint }] : [],
  });

  const signer = new ccc.SignerCkbScriptReadonly(client, lock);

  // The output is added last in both branches, so CellOutput.from can
  // compute its minimum capacity from the final lock+type+data all at once.
  let typeId: ccc.Hex;
  if (prevTypeScript) {
    typeId = ccc.Script.from(prevTypeScript).args;
    tx.addOutput({ lock, type: prevTypeScript }, manifestBytes);
  } else {
    // Type ID args are derived from the tx's first input, so one must
    // exist before we can compute them — even if capacity doesn't
    // otherwise require an input yet.
    await tx.completeInputsAtLeastOne(signer);
    typeId = ccc.hashTypeId(tx.inputs[0]!, 0);
    const typeIdInfo = await client.getKnownScript(ccc.KnownScript.TypeId);
    await tx.addCellDepInfos(client, typeIdInfo.cellDeps);
    tx.addOutput({ lock, type: ccc.Script.from({ ...typeIdInfo, args: typeId }) }, manifestBytes);
  }

  await tx.completeInputsByCapacity(signer);
  await reserveSighashWitness(tx, lock, client);
  await tx.completeFeeBy(signer, feeRate ?? DEFAULT_FEE_RATE);

  return { tx, typeId };
}
