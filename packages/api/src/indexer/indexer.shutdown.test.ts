import { describe, expect, it } from "vitest";
import { ccc } from "@ckb-ccc/ccc";
import { openDb } from "../db/open.js";
import { Indexer } from "./indexer.js";
import { FakeChainClient } from "./fakeChainClient.js";
import { anchorTx, manifestBytesFor } from "./testFixtures.js";
import type { IndexerClient } from "./types.js";

/** Wraps a FakeChainClient and adds a per-block delay to `getBlockByNumber`, so a
 * catch-up spanning many blocks takes long enough to interrupt mid-flight. */
class SlowChainClient implements IndexerClient {
  constructor(
    private readonly inner: FakeChainClient,
    private readonly delayMs: number,
  ) {}

  get addressPrefix(): string {
    return this.inner.addressPrefix;
  }

  getTip(): Promise<ccc.Num> {
    return this.inner.getTip();
  }

  async getBlockByNumber(blockNumber: ccc.NumLike): Promise<ccc.ClientBlock | undefined> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.getBlockByNumber(blockNumber);
  }

  getKnownScript(script: ccc.KnownScript): Promise<ccc.ScriptInfo> {
    return this.inner.getKnownScript(script);
  }
}

describe("indexer shutdown", () => {
  it("stop() interrupts a long catch-up promptly instead of running it to completion", async () => {
    const db = openDb(":memory:");
    const inner = new FakeChainClient();
    for (let i = 0; i < 20; i++) {
      inner.addBlock([anchorTx(await manifestBytesFor(`Project ${i}`))]);
    }
    const client = new SlowChainClient(inner, 30);

    // Long poll interval: if shutdown were only checked between pollOnce()
    // calls (the old behavior), stop() would have to wait out this entire
    // 20-block catch-up (~600ms) before resolving.
    const indexer = new Indexer({ db, client, startBlock: 0n, pollIntervalMs: 60_000 });
    indexer.start();

    // Let a couple of blocks index, then request shutdown mid-catch-up.
    await new Promise((resolve) => setTimeout(resolve, 65));
    const stopStarted = Date.now();
    await indexer.stop();
    const stopDurationMs = Date.now() - stopStarted;

    // Should return promptly (at most ~one more block's delay), not wait for
    // all 20 blocks (~600ms) to finish processing.
    expect(stopDurationMs).toBeLessThan(300);

    const state = db.prepare("SELECT last_block_number FROM sync_state").get() as {
      last_block_number: number;
    };
    expect(state.last_block_number).toBeGreaterThan(0);
    expect(state.last_block_number).toBeLessThan(20);

    db.close();
  });

  it("stop() interrupts the idle poll-interval sleep promptly", async () => {
    const db = openDb(":memory:");
    const client = new FakeChainClient();
    client.addBlock([anchorTx(await manifestBytesFor("Project idle"))]);

    const indexer = new Indexer({ db, client, startBlock: 0n, pollIntervalMs: 60_000 });
    indexer.start();
    // Let the single block index, then the loop settles into its idle sleep.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stopStarted = Date.now();
    await indexer.stop();
    const stopDurationMs = Date.now() - stopStarted;

    expect(stopDurationMs).toBeLessThan(300);

    db.close();
  });
});
