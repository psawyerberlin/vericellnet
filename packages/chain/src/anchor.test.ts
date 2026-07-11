import { describe, expect, it } from "vitest";
import { ccc } from "@ckb-ccc/ccc";
import { buildAnchorTx, buildAnchorTxWithTypeId } from "./anchor.js";
import { FakeClient } from "./fakeClient.js";

const LOCK = ccc.Script.from({
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
  args: "0x59a27ef3ba84f061517d13f42cf44ed020610061",
});

const MANIFEST_BYTES = new TextEncoder().encode('{"app":"vericell","v":1}');

function seedWalletCapacity(client: FakeClient, txHash: string, capacityCkb: number) {
  return client.addLiveCell({
    outPoint: { txHash, index: 0 },
    cellOutput: { capacity: ccc.fixedPointFrom(capacityCkb), lock: LOCK },
    outputData: "0x",
  });
}

describe("buildAnchorTx", () => {
  it("shapes a first-version anchor tx with auto capacity", async () => {
    const client = new FakeClient();
    seedWalletCapacity(client, "0x" + "11".repeat(32), 500);

    const tx = await buildAnchorTx({ client, lock: LOCK, manifestBytes: MANIFEST_BYTES });

    // The seeded wallet cell (500 CKB) covers the anchor output several
    // times over, so completeFeeBy adds a second, change output.
    expect(tx.outputs.length).toBeGreaterThanOrEqual(1);
    expect(tx.outputs[0]!.lock.eq(LOCK)).toBe(true);
    expect(tx.outputs[0]!.type).toBeUndefined();
    expect(tx.outputsData[0]).toBe(ccc.hexFrom(MANIFEST_BYTES));
    expect(tx.inputs.length).toBeGreaterThan(0);

    const fee = await tx.getFee(client);
    expect(fee).toBeGreaterThan(0n);
  });

  it("consumes the previous version's cell as the first input", async () => {
    const client = new FakeClient();
    const prevTxHash = "0x" + "22".repeat(32);
    const prev = client.addLiveCell({
      outPoint: { txHash: prevTxHash, index: 0 },
      cellOutput: { capacity: ccc.fixedPointFrom(200), lock: LOCK },
      outputData: ccc.hexFrom(new TextEncoder().encode('{"app":"vericell","v":1,"prev":"x"}')),
    });
    seedWalletCapacity(client, "0x" + "33".repeat(32), 500);

    const tx = await buildAnchorTx({
      client,
      lock: LOCK,
      manifestBytes: MANIFEST_BYTES,
      prevOutPoint: prev.outPoint,
    });

    expect(tx.inputs[0]!.previousOutput.eq(prev.outPoint)).toBe(true);
  });
});

describe("buildAnchorTxWithTypeId", () => {
  it("computes Type ID args from the tx's first input on the first version", async () => {
    const client = new FakeClient();
    seedWalletCapacity(client, "0x" + "44".repeat(32), 500);

    const { tx, typeId } = await buildAnchorTxWithTypeId({
      client,
      lock: LOCK,
      manifestBytes: MANIFEST_BYTES,
    });

    expect(tx.inputs.length).toBeGreaterThan(0);
    expect(typeId).toBe(ccc.hashTypeId(tx.inputs[0]!, 0));
    expect(tx.outputs[0]!.type?.args).toBe(typeId);
    expect(tx.outputs[0]!.type?.codeHash).toBe(
      "0x00000000000000000000000000000000000000000000000000545950455f4944",
    );

    const fee = await tx.getFee(client);
    expect(fee).toBeGreaterThan(0n);
  });

  it("carries the previous version's Type ID script over unchanged", async () => {
    const client = new FakeClient();
    const typeId = "0x" + "aa".repeat(32);
    const prevType = ccc.Script.from({
      codeHash: "0x00000000000000000000000000000000000000000000000000545950455f4944",
      hashType: "type",
      args: typeId,
    });
    const prevTxHash = "0x" + "55".repeat(32);
    const prev = client.addLiveCell({
      outPoint: { txHash: prevTxHash, index: 0 },
      cellOutput: { capacity: ccc.fixedPointFrom(200), lock: LOCK, type: prevType },
      outputData: ccc.hexFrom(MANIFEST_BYTES),
    });
    seedWalletCapacity(client, "0x" + "66".repeat(32), 500);

    const { tx, typeId: returnedId } = await buildAnchorTxWithTypeId({
      client,
      lock: LOCK,
      manifestBytes: MANIFEST_BYTES,
      prevOutPoint: prev.outPoint,
      prevTypeScript: prevType,
    });

    expect(returnedId).toBe(typeId);
    expect(tx.outputs[0]!.type?.eq(prevType)).toBe(true);
    expect(tx.inputs[0]!.previousOutput.eq(prev.outPoint)).toBe(true);
  });

  it("requires prevTypeScript when prevOutPoint is set", async () => {
    const client = new FakeClient();
    const prev = client.addLiveCell({
      outPoint: { txHash: "0x" + "77".repeat(32), index: 0 },
      cellOutput: { capacity: ccc.fixedPointFrom(200), lock: LOCK },
      outputData: "0x",
    });

    await expect(
      buildAnchorTxWithTypeId({
        client,
        lock: LOCK,
        manifestBytes: MANIFEST_BYTES,
        prevOutPoint: prev.outPoint,
      }),
    ).rejects.toThrow(/prevTypeScript/);
  });
});
