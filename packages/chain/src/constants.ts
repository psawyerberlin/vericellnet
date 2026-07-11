/**
 * Fallback fee rate (shannons per 1000 bytes) used when the caller doesn't
 * pass one. `Transaction.completeFeeBy` otherwise asks the node for a
 * fee-rate estimate, which fails on a freshly started devnet with no
 * transaction history to sample.
 *
 * Set at 2x CKB's own minimum relay rate (1000): `Transaction.estimateFee`
 * sizes the tx from `toBytes().length`, but at least one observed CKB
 * version (0.207.0) rejects at the minimum rate by a few dozen shannons —
 * its actual weight-based accounting isn't quite pure byte size. Overpaying
 * this much is negligible on any network and avoids relying on exact
 * agreement between CCC's size estimate and the node's fee metering.
 */
export const DEFAULT_FEE_RATE = 2000n;
