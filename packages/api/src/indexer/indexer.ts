import { setTimeout as delay } from "node:timers/promises";
import type Database from "better-sqlite3";
import { ccc } from "@ckb-ccc/ccc";
import { processBlock } from "./process.js";
import { getSyncState, setSyncState, rollback } from "./reorg.js";
import type { IndexerClient } from "./types.js";

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const NOOP_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
};

export interface IndexerOptions {
  db: Database.Database;
  client: IndexerClient;
  logger?: Logger;
  /** Poll interval between iterations once the cursor has caught up to tip. */
  pollIntervalMs?: number;
  /** First block to index when `sync_state` is empty. */
  startBlock?: bigint;
  /** Fixed rollback depth on reorg detection (see reorg.ts). */
  reorgDepth?: bigint;
}

/**
 * Chain-following worker: reads `sync_state`, fetches blocks from the
 * cursor to tip, indexes VeriCell proof cells, and handles reorgs. See
 * ClaudeCodeInstruction.md Phase 3 and TECHNICAL.md §6.
 */
export class Indexer {
  private readonly db: Database.Database;
  private readonly client: IndexerClient;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly startBlock: bigint;
  private readonly reorgDepth: bigint;

  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private typeIdInfo: ccc.ScriptInfo | null = null;
  // A fresh controller per start()/stop() cycle; the constructor's default
  // (never aborted) is what a standalone `pollOnce()` call runs under —
  // tests call it directly without start(), and it must always run a full
  // catch-up in that mode. Only a loop driven through start() can be
  // interrupted mid-catch-up, via stop()'s abort() below.
  private abortController = new AbortController();

  constructor(opts: IndexerOptions) {
    this.db = opts.db;
    this.client = opts.client;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.startBlock = opts.startBlock ?? 0n;
    this.reorgDepth = opts.reorgDepth ?? 6n;
  }

  /**
   * Index every new block from the cursor to the current tip once. Exposed
   * separately from the poll loop so tests can step deterministically
   * (including simulating a kill/restart between iterations).
   */
  async pollOnce(): Promise<void> {
    this.typeIdInfo ??= await this.client.getKnownScript(ccc.KnownScript.TypeId);

    let state = getSyncState(this.db);

    // A reorg that doesn't grow the chain past our last-seen tip (a
    // same-height or shorter replacement) would never trigger the
    // parent-hash check below, since that only fires while fetching blocks
    // *beyond* the cursor. Re-validate the block we last recorded first.
    if (state.lastBlockNumber !== null && state.lastBlockHash !== null) {
      const current = await this.client.getBlockByNumber(state.lastBlockNumber);
      if (!current || current.header.hash !== state.lastBlockHash) {
        this.logger.warn(
          { cursor: state.lastBlockNumber.toString() },
          "reorg detected: last-indexed block hash mismatch, rolling back",
        );
        await rollback(this.db, this.client, state.lastBlockNumber, this.reorgDepth);
        state = getSyncState(this.db);
      }
    }

    const tip = await this.client.getTip();
    let cursor = state.lastBlockNumber ?? this.startBlock - 1n;

    while (cursor < tip) {
      // Checked every iteration (not just between pollOnce() calls) so a
      // long catch-up spanning many blocks can be interrupted promptly —
      // only set once start()'s loop is stop()ped; a standalone pollOnce()
      // call (as in tests) always runs to completion, see the field comment.
      if (this.abortController.signal.aborted) break;

      const next = cursor + 1n;
      const block = await this.client.getBlockByNumber(next);
      if (!block) break;

      if (state.lastBlockHash && block.header.parentHash !== state.lastBlockHash) {
        this.logger.warn(
          { cursor: cursor.toString(), newBlockHash: block.header.hash },
          "reorg detected: parent hash mismatch, rolling back",
        );
        cursor = await rollback(this.db, this.client, cursor, this.reorgDepth);
        state = getSyncState(this.db);
        continue;
      }

      processBlock(this.db, block, this.typeIdInfo, this.client.addressPrefix);
      setSyncState(this.db, next, block.header.hash);
      cursor = next;
      state = { lastBlockNumber: next, lastBlockHash: block.header.hash };
      this.logger.info({ blockNumber: next.toString() }, "indexed block");
    }
  }

  /** Start the poll loop in the background. Call `stop()` to shut down cleanly. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.abortController = new AbortController();
    this.loopPromise = this.runLoop();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.logger.error({ err }, "indexer poll iteration failed");
      }
      if (this.stopped) break;
      try {
        // Interruptible: stop() aborts this immediately instead of leaving
        // shutdown waiting out the full poll interval.
        await delay(this.pollIntervalMs, undefined, { signal: this.abortController.signal });
      } catch {
        break;
      }
    }
  }

  /**
   * Signal the loop to stop and wait for the in-flight iteration to finish.
   * Aborts a mid-catch-up pollOnce() (stops after the block currently being
   * processed, not the whole remaining range to tip) and the idle poll-
   * interval sleep alike, so shutdown never waits out either one.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController.abort();
    await this.loopPromise;
    this.loopPromise = null;
  }
}
