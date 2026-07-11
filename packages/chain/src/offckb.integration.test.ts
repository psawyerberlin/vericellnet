/**
 * Integration suite against a real offckb devnet node.
 *
 * Setup (not automated here — see docs/DECISIONS.md "Phase 2"):
 *   1. `npm i -g @offckb/cli && offckb node` (leave it running; RPC proxy
 *      defaults to http://127.0.0.1:28114, matched by makeClient's devnet
 *      default — override with VERICELL_DEVNET_RPC_URL if yours differs).
 *   2. Pick one of `offckb accounts`' pre-funded devnet keys and export it
 *      as `VERICELL_OFFCKB_PRIVATE_KEY` (32-byte hex, 0x-prefixed).
 *   3. `offckb system-scripts --export-style ccc --network devnet` (drop the
 *      banner's first line), save the JSON, and point
 *      `VERICELL_DEVNET_SCRIPTS_FILE` at it — devnet's system scripts (e.g.
 *      Secp256k1Blake160) are deployed at different cell-dep out points
 *      than testnet/mainnet, so signing fails without this.
 *   4. `OFFCKB=1 pnpm --filter chain test` (or `pnpm --filter chain test:offckb`)
 *
 * Skipped entirely unless `OFFCKB=1`, so `pnpm test` stays green without a
 * devnet available.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ccc } from "@ckb-ccc/ccc";
import { encodeManifest, projectHash, merkleRoot, type Manifest } from "core";
import { makeClient } from "./client.js";
import { buildAnchorTx, buildAnchorTxWithTypeId } from "./anchor.js";
import { buildWithdrawTx } from "./withdraw.js";
import { fetchProof } from "./proof.js";
import { findLiveProofsByTypeId } from "./collectors.js";

const OFFCKB_ENABLED = globalThis.process?.env?.OFFCKB === "1";

async function manifestBytesFor(title: string, extra?: Partial<Manifest>): Promise<Uint8Array> {
  const entries = [{ path: "README.md", hash: "a".repeat(64) }];
  const manifest: Manifest = {
    app: "vericell",
    v: 1,
    title,
    created: new Date().toISOString(),
    project_sha256: await projectHash(entries),
    merkle_root: await merkleRoot(entries),
    count: entries.length,
    ...extra,
  };
  return encodeManifest(manifest);
}

describe.skipIf(!OFFCKB_ENABLED)("chain layer against offckb devnet", () => {
  let client: ccc.Client;
  let signer: ccc.SignerCkbPrivateKey;
  let lock: ccc.Script;

  beforeAll(async () => {
    const privateKey = globalThis.process?.env?.VERICELL_OFFCKB_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error(
        "OFFCKB=1 requires VERICELL_OFFCKB_PRIVATE_KEY to be set to a funded devnet account's private key.",
      );
    }
    if (!globalThis.process?.env?.VERICELL_DEVNET_SCRIPTS_FILE) {
      throw new Error(
        "OFFCKB=1 requires VERICELL_DEVNET_SCRIPTS_FILE (see this file's header comment) — " +
          "without it, signing uses testnet's system-script cell deps, which don't exist on your devnet.",
      );
    }
    client = makeClient("devnet");
    signer = new ccc.SignerCkbPrivateKey(client, privateKey);
    await signer.connect();
    lock = (await signer.getRecommendedAddressObj()).script;
  }, 30000);

  it("v1 versioning (no Type ID): anchor, supersede, withdraw", async () => {
    const tx1 = await buildAnchorTx({
      client,
      lock,
      manifestBytes: await manifestBytesFor("v1 project"),
    });
    const txHash1 = await signer.sendTransaction(tx1);
    await client.waitTransaction(txHash1);

    const proof1 = await fetchProof(client, txHash1, 0);
    expect(proof1.live).toBe(true);
    expect(proof1.manifest?.title).toBe("v1 project");

    const tx2 = await buildAnchorTx({
      client,
      lock,
      manifestBytes: await manifestBytesFor("v1 project v2", { genesis: txHash1, prev: txHash1 }),
      prevOutPoint: { txHash: txHash1, index: 0 },
    });
    const txHash2 = await signer.sendTransaction(tx2);
    await client.waitTransaction(txHash2);

    const proof1After = await fetchProof(client, txHash1, 0);
    expect(proof1After.live).toBe(false);

    const proof2 = await fetchProof(client, txHash2, 0);
    expect(proof2.live).toBe(true);
    expect(proof2.manifest?.genesis).toBe(txHash1);
    expect(proof2.manifest?.prev).toBe(txHash1);

    const consumedCapacity = (await client.getCell({ txHash: txHash2, index: 0 }))!.cellOutput
      .capacity;
    const tx3 = await buildWithdrawTx({ client, lock, outPoint: { txHash: txHash2, index: 0 } });
    const txHash3 = await signer.sendTransaction(tx3);
    await client.waitTransaction(txHash3);

    const proof2After = await fetchProof(client, txHash2, 0);
    expect(proof2After.live).toBe(false);

    const refund = await client.getCellLive({ txHash: txHash3, index: 0 }, false);
    expect(refund).toBeDefined();
    expect(refund!.cellOutput.lock.eq(lock)).toBe(true);
    expect(refund!.cellOutput.capacity).toBeLessThan(consumedCapacity);
    expect(refund!.cellOutput.capacity).toBeGreaterThan(0n);
  }, 60000);

  it("Type ID versioning: UNID is stable across versions and only the live cell is found", async () => {
    const { tx: tx1, typeId } = await buildAnchorTxWithTypeId({
      client,
      lock,
      manifestBytes: await manifestBytesFor("type-id project"),
    });
    const txHash1 = await signer.sendTransaction(tx1);
    await client.waitTransaction(txHash1);

    const liveAfterV1 = [];
    for await (const cell of findLiveProofsByTypeId(client, typeId)) liveAfterV1.push(cell);
    expect(liveAfterV1).toHaveLength(1);
    expect(liveAfterV1[0]!.outPoint.txHash).toBe(txHash1);

    const prevCell = await client.getCell({ txHash: txHash1, index: 0 });
    const { tx: tx2, typeId: typeId2 } = await buildAnchorTxWithTypeId({
      client,
      lock,
      manifestBytes: await manifestBytesFor("type-id project v2", {
        genesis: txHash1,
        prev: txHash1,
      }),
      prevOutPoint: { txHash: txHash1, index: 0 },
      prevTypeScript: prevCell!.cellOutput.type!,
    });
    expect(typeId2).toBe(typeId);
    const txHash2 = await signer.sendTransaction(tx2);
    await client.waitTransaction(txHash2);

    const liveAfterV2 = [];
    for await (const cell of findLiveProofsByTypeId(client, typeId)) liveAfterV2.push(cell);
    expect(liveAfterV2).toHaveLength(1);
    expect(liveAfterV2[0]!.outPoint.txHash).toBe(txHash2);
  }, 60000);
});
