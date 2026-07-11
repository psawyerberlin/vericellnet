import { describe, expect, it } from "vitest";
import { ccc } from "@ckb-ccc/ccc";
import { findLiveProofsByTypeId, findVeriCells } from "./collectors.js";
import { FakeClient } from "./fakeClient.js";

const LOCK = ccc.Script.from({
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
  args: "0x59a27ef3ba84f061517d13f42cf44ed020610061",
});

const TYPE_ID_CODE_HASH = "0x00000000000000000000000000000000000000000000000000545950455f4944";

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("findLiveProofsByTypeId", () => {
  it("only yields cells whose Type ID args match", async () => {
    const client = new FakeClient();
    const wantedArgs = "0x" + "11".repeat(32);
    const otherArgs = "0x" + "22".repeat(32);

    const wanted = client.addLiveCell({
      outPoint: { txHash: "0x" + "aa".repeat(32), index: 0 },
      cellOutput: {
        capacity: ccc.fixedPointFrom(200),
        lock: LOCK,
        type: { codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: wantedArgs },
      },
      outputData: "0x",
    });
    client.addLiveCell({
      outPoint: { txHash: "0x" + "bb".repeat(32), index: 0 },
      cellOutput: {
        capacity: ccc.fixedPointFrom(200),
        lock: LOCK,
        type: { codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: otherArgs },
      },
      outputData: "0x",
    });

    const results = await collect(findLiveProofsByTypeId(client, wantedArgs));

    expect(results).toHaveLength(1);
    expect(results[0]!.outPoint.eq(wanted.outPoint)).toBe(true);
  });
});

describe("findVeriCells", () => {
  it("only yields cells at the lock whose data has the VeriCell manifest signature", async () => {
    const client = new FakeClient();
    const proof = client.addLiveCell({
      outPoint: { txHash: "0x" + "cc".repeat(32), index: 0 },
      cellOutput: { capacity: ccc.fixedPointFrom(200), lock: LOCK },
      outputData: ccc.hexFrom(new TextEncoder().encode('{"app":"vericell","v":1}')),
    });
    client.addLiveCell({
      outPoint: { txHash: "0x" + "dd".repeat(32), index: 0 },
      cellOutput: { capacity: ccc.fixedPointFrom(200), lock: LOCK },
      outputData: ccc.hexFrom(new TextEncoder().encode('{"app":"something-else"}')),
    });

    const results = await collect(findVeriCells(client, LOCK));

    expect(results).toHaveLength(1);
    expect(results[0]!.outPoint.eq(proof.outPoint)).toBe(true);
  });
});
