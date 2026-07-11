import { ccc } from "@ckb-ccc/ccc";

/** Standard secp256k1 signature length CCC's own signers reserve for a sighash-all witness. */
const SECP256K1_SIGNATURE_LENGTH = 65;

/**
 * Reserve a placeholder witness at `lock`'s input, sized like a standard
 * single-signature unlock (secp256k1 — also what JoyID produces). Without
 * this, `completeFeeBy` estimates the tx's size from a witness-less
 * transaction, undershoots the fee, and the real signer's witness (added
 * later, when the caller actually signs) pushes the tx below the network's
 * minimum relay fee rate. The real signer overwrites this same witness
 * position with the real signature, so the final size matches.
 */
export async function reserveSighashWitness(
  tx: ccc.Transaction,
  lock: ccc.ScriptLike,
  client: ccc.Client,
): Promise<void> {
  await tx.prepareSighashAllWitness(lock, SECP256K1_SIGNATURE_LENGTH, client);
}
