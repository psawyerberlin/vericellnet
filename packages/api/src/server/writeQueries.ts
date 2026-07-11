import type Database from "better-sqlite3";
import type { Manifest } from "core";

interface InsertPendingVersionParams {
  txHash: string;
  unid: string;
  manifest: Manifest;
  ownerAddress: string;
}

/**
 * Insert a `pending` version row (and upsert its `projects` row) immediately
 * after broadcasting — before the indexer has seen the block. Makes the new
 * proof discoverable right away instead of only once confirmed; the
 * indexer's own `upsertCandidate` (`indexer/process.ts`) later flips
 * `status` to `committed` via its `ON CONFLICT ... WHERE versions.status !=
 * 'consumed'` upsert, which this pending row is designed to satisfy without
 * any indexer-side special-casing.
 *
 * `live_tx_hash`/`live_index` are advanced optimistically even for a *new
 * version* of an existing project (not just a brand-new one) — this is
 * load-bearing, not just a UX nicety: a custodial caller chaining anchor →
 * new version → withdraw in quick succession (the exact `ClaudeCodeInstruction.md`
 * Phase 5 acceptance flow) needs `live_tx_hash` to already point at the new
 * version's cell by the time the withdraw request resolves it, or the
 * withdraw builds a tx against the now-dead previous cell and the broadcast
 * is rejected (`TransactionFailedToResolve`). The trade-off — a pending tx
 * that never confirms leaves `live_tx_hash` pointing at a cell that isn't
 * actually live — is the same one already accepted for brand-new projects;
 * reconciling a stuck/dropped pending tx is out of scope for this phase.
 */
export function insertPendingVersion(
  db: Database.Database,
  params: InsertPendingVersionParams,
): void {
  const { txHash, unid, manifest, ownerAddress } = params;

  let versionNo = 1;
  if (manifest.prev) {
    const prev = db
      .prepare("SELECT version_no FROM versions WHERE tx_hash = ?")
      .get(manifest.prev) as { version_no: number } | undefined;
    versionNo = (prev?.version_no ?? 0) + 1;
  }

  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO projects (unid, title, source_url, ckb_address, created_at, active, live_tx_hash, live_index)
     VALUES (@unid, @title, @sourceUrl, @ckbAddress, @createdAt, 1, @txHash, 0)
     ON CONFLICT(unid) DO UPDATE SET
       title = excluded.title,
       source_url = excluded.source_url,
       ckb_address = excluded.ckb_address,
       active = 1,
       live_tx_hash = excluded.live_tx_hash,
       live_index = 0`,
  ).run({
    unid,
    title: manifest.title,
    sourceUrl: manifest.source ?? null,
    ckbAddress: ownerAddress,
    createdAt: now,
    txHash,
  });

  db.prepare(
    `INSERT INTO versions (tx_hash, unid, version_no, prev_tx_hash, project_sha256, merkle_root, block_number, block_time, status)
     VALUES (@txHash, @unid, @versionNo, @prevTxHash, @projectSha256, @merkleRoot, NULL, NULL, 'pending')
     ON CONFLICT(tx_hash) DO NOTHING`,
  ).run({
    txHash,
    unid,
    versionNo,
    prevTxHash: manifest.prev ?? null,
    projectSha256: manifest.project_sha256,
    merkleRoot: manifest.merkle_root ?? null,
  });
}

/**
 * Optimistically reflect a broadcast (not-yet-indexed) withdraw: clears the
 * project's `live_tx_hash`/`active` right away. Deliberately does *not*
 * touch the consumed version's own `status` — that transition is
 * `consumed_at_block`-tracked for reorg rollback (see indexer/reorg.ts) and
 * must only ever be set alongside a real block number.
 */
export function markProjectWithdrawnPending(db: Database.Database, unid: string): void {
  db.prepare("UPDATE projects SET active = 0, live_tx_hash = NULL WHERE unid = ?").run(unid);
}
