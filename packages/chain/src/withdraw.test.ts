import { describe, expect, it } from "vitest";
import { ccc } from "@ckb-ccc/ccc";
import { buildWithdrawTx } from "./withdraw.js";
import { FakeClient } from "./fakeClient.js";

const LOCK = ccc.Script.from({
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
  args: "0x59a27ef3ba84f061517d13f42cf44ed020610061",
});

describe("buildWithdrawTx", () => {
  it("consumes the proof cell and refunds capacity minus fee, with no successor", async () => {
    const client = new FakeClient();
    const proof = client.addLiveCell({
      outPoint: { txHash: "0x" + "88".repeat(32), index: 0 },
      cellOutput: { capacity: ccc.fixedPointFrom(120), lock: LOCK },
      outputData: ccc.hexFrom(new TextEncoder().encode('{"app":"vericell","v":1}')),
    });

    const tx = await buildWithdrawTx({ client, lock: LOCK, outPoint: proof.outPoint });

    expect(tx.inputs).toHaveLength(1);
    expect(tx.inputs[0]!.previousOutput.eq(proof.outPoint)).toBe(true);
    expect(tx.outputs).toHaveLength(1);
    expect(tx.outputs[0]!.lock.eq(LOCK)).toBe(true);
    expect(tx.outputs[0]!.type).toBeUndefined();
    expect(tx.outputs[0]!.capacity).toBeLessThan(proof.cellOutput.capacity);
    expect(tx.outputs[0]!.capacity).toBeGreaterThan(0n);

    const fee = await tx.getFee(client);
    expect(fee).toBeGreaterThan(0n);
    expect(proof.cellOutput.capacity - tx.outputs[0]!.capacity).toBe(fee);
  });
});
