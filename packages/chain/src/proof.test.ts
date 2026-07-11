import { describe, expect, it } from "vitest";
import { ccc } from "@ckb-ccc/ccc";
import { encodeManifest, type Manifest } from "core";
import { fetchProof } from "./proof.js";
import { FakeClient } from "./fakeClient.js";

const LOCK = ccc.Script.from({
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
  args: "0x59a27ef3ba84f061517d13f42cf44ed020610061",
});

const MANIFEST: Manifest = {
  app: "vericell",
  v: 1,
  title: "Test project",
  created: "2026-01-01T00:00:00Z",
  project_sha256: "a".repeat(64),
  merkle_root: "b".repeat(64),
  count: 1,
};

describe("fetchProof", () => {
  it("returns manifest, live status, block time and owner for a live cell", async () => {
    const client = new FakeClient();
    const blockHash = "0x" + "cc".repeat(32);
    client.addHeader({
      compactTarget: 0,
      dao: { c: 0, ar: 0, s: 0, u: 0 },
      epoch: "0x0",
      extraHash: "0x" + "00".repeat(32),
      hash: blockHash,
      nonce: 0,
      number: 1,
      parentHash: "0x" + "00".repeat(32),
      proposalsHash: "0x" + "00".repeat(32),
      timestamp: 1735689600000,
      transactionsRoot: "0x" + "00".repeat(32),
      version: 0,
    });

    const manifestBytes = encodeManifest(MANIFEST);
    const tx = ccc.Transaction.from({ outputs: [{ lock: LOCK }], outputsData: [manifestBytes] });
    const txHash = await client.sendTransactionNoCache(tx);
    const stored = await client.getTransactionNoCache(txHash);
    stored!.blockHash = ccc.hexFrom(blockHash);

    const result = await fetchProof(client, txHash, 0);

    expect(result.manifest).toEqual(MANIFEST);
    expect(result.live).toBe(true);
    expect(result.blockNumber).toBe(1n);
    expect(result.blockTime?.getTime()).toBe(1735689600000);
    expect(result.ownerAddress).toBe(ccc.Address.fromScript(LOCK, client).toString());
  });

  it("reports live: false once the cell has been consumed", async () => {
    const client = new FakeClient();
    const manifestBytes = encodeManifest(MANIFEST);
    const tx = ccc.Transaction.from({ outputs: [{ lock: LOCK }], outputsData: [manifestBytes] });
    const txHash = await client.sendTransactionNoCache(tx);

    // Spend it: a follow-up tx consumes the cell with no successor.
    const spend = ccc.Transaction.from({ inputs: [{ previousOutput: { txHash, index: 0 } }] });
    await client.sendTransactionNoCache(spend);

    const result = await fetchProof(client, txHash, 0);
    expect(result.manifest).toEqual(MANIFEST);
    expect(result.live).toBe(false);
  });

  it("returns a null manifest for non-VeriCell cell data", async () => {
    const client = new FakeClient();
    const tx = ccc.Transaction.from({
      outputs: [{ lock: LOCK }],
      outputsData: [new TextEncoder().encode("not json")],
    });
    const txHash = await client.sendTransactionNoCache(tx);

    const result = await fetchProof(client, txHash, 0);
    expect(result.manifest).toBeNull();
    expect(result.live).toBe(true);
  });

  it("returns an empty result for an unknown tx hash", async () => {
    const client = new FakeClient();
    const result = await fetchProof(client, "0x" + "ff".repeat(32), 0);
    expect(result.manifest).toBeNull();
    expect(result.live).toBeNull();
    expect(result.blockTime).toBeNull();
  });
});
