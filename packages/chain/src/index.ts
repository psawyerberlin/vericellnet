export { makeClient } from "./client.js";
export {
  buildAnchorTx,
  buildAnchorTxWithTypeId,
  type BuildAnchorTxParams,
  type BuildAnchorTxWithTypeIdParams,
  type AnchorTxWithTypeId,
} from "./anchor.js";
export { fetchProof, type ProofResult } from "./proof.js";
export {
  findLiveProofsByTypeId,
  findVeriCells,
  looksLikeVeriCellData,
  LEGACY_DATA_PREFIX,
} from "./collectors.js";
export { buildWithdrawTx, type BuildWithdrawTxParams } from "./withdraw.js";
export { PURE_CAPACITY_FILTER } from "./filters.js";
export { DEFAULT_FEE_RATE } from "./constants.js";
// Exported (Phase 5) so `api`'s route-level unit tests can exercise
// prepare/submit/custodial flows without a real offckb devnet — see this
// package's DECISIONS.md.
export { FakeClient } from "./fakeClient.js";

export { ccc } from "@ckb-ccc/ccc";
