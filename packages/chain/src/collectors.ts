import { ccc } from "@ckb-ccc/ccc";

const LEGACY_DATA_PREFIX = '{"app":"vericell"';

function looksLikeVeriCellData(outputData: ccc.Hex): boolean {
  const bytes = ccc.bytesFrom(outputData);
  const prefix = new TextDecoder().decode(bytes.slice(0, LEGACY_DATA_PREFIX.length));
  return prefix === LEGACY_DATA_PREFIX;
}

/** Find live proof cells for a project by its Type ID args. */
export async function* findLiveProofsByTypeId(
  client: ccc.Client,
  typeArgs: ccc.HexLike,
): AsyncGenerator<ccc.Cell> {
  const typeIdInfo = await client.getKnownScript(ccc.KnownScript.TypeId);
  const type = ccc.Script.from({ ...typeIdInfo, args: typeArgs });
  yield* client.findCellsByType(type);
}

/**
 * Find live VeriCell proof cells owned by a lock — the v1 (no Type ID)
 * fallback used when a project has no type script: any live cell at this
 * lock whose data starts with the VeriCell manifest signature.
 */
export async function* findVeriCells(
  client: ccc.Client,
  lock: ccc.ScriptLike,
): AsyncGenerator<ccc.Cell> {
  for await (const cell of client.findCellsByLock(lock, null, true)) {
    if (looksLikeVeriCellData(cell.outputData)) {
      yield cell;
    }
  }
}
