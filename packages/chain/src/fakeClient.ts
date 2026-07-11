import { ccc } from "@ckb-ccc/ccc";

/**
 * A minimal in-memory `ccc.Client` for pure unit tests: no network, no RPC.
 * It implements just enough of the abstract `Client` surface for the tx
 * builders in this package (findCells, completeInputsByCapacity,
 * completeFeeBy, sendTransaction, getTransaction, getCellLive,
 * getHeaderByHash). Anything else throws — that's a signal the test is
 * exercising a path this fake doesn't need to support yet.
 */
export class FakeClient extends ccc.Client {
  private readonly liveCells = new Map<string, ccc.Cell>();
  private readonly txs = new Map<string, ccc.ClientTransactionResponse>();
  private readonly headers = new Map<string, ccc.ClientBlockHeader>();
  private tipNumber = 0n;
  public feeRate = 1000n;

  get url(): string {
    return "fake://client";
  }

  get addressPrefix(): string {
    return "ckt";
  }

  /**
   * Seed a live, unspent cell as if it were already on-chain. Also
   * registers a synthetic funding transaction under the cell's own
   * out point, because `CellInput.getCell` (used by capacity/fee
   * calculations) resolves cells via `getTransaction`, not the live-cell
   * index.
   */
  addLiveCell(cell: ccc.CellLike): ccc.Cell {
    const c = ccc.Cell.from(cell);
    this.liveCells.set(outPointKey(c.outPoint), c);

    const index = Number(c.outPoint.index);
    const outputs = Array.from({ length: index + 1 }, (_, i) =>
      i === index ? c.cellOutput : ccc.CellOutput.from({ capacity: 0, lock: c.cellOutput.lock }),
    );
    const outputsData = Array.from({ length: index + 1 }, (_, i) =>
      i === index ? c.outputData : "0x",
    );
    this.txs.set(
      c.outPoint.txHash,
      ccc.ClientTransactionResponse.from({
        transaction: ccc.Transaction.from({ outputs, outputsData }),
        status: "committed",
      }),
    );

    return c;
  }

  /** Seed a confirmed block header, addressable by both number and hash. */
  addHeader(header: ccc.ClientBlockHeaderLike): ccc.ClientBlockHeader {
    const h = ccc.ClientBlockHeader.from(header);
    this.headers.set(`n:${h.number}`, h);
    this.headers.set(`h:${h.hash}`, h);
    if (h.number > this.tipNumber) this.tipNumber = h.number;
    return h;
  }

  async getKnownScript(script: ccc.KnownScript): Promise<ccc.ScriptInfo> {
    if (script === ccc.KnownScript.TypeId) {
      return ccc.ScriptInfo.from({
        codeHash: "0x00000000000000000000000000000000000000000000000000545950455f4944",
        hashType: "type",
        cellDeps: [],
      });
    }
    if (script === ccc.KnownScript.Secp256k1Blake160) {
      // Real testnet/mainnet codeHash — lets a `SignerCkbPrivateKey` derive
      // a lock/address against this fake client the same way it would
      // against a real one (`getRecommendedAddressObj`, used by callers
      // outside this package that need an actual signer, not just a
      // hand-rolled `ScriptLike` fixture).
      return ccc.ScriptInfo.from({
        codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
        hashType: "type",
        cellDeps: [],
      });
    }
    if (script === ccc.KnownScript.NervosDao || script === ccc.KnownScript.AnyoneCanPay) {
      // Never matched by any fixture cell — completeInputsByCapacity (DAO)
      // and SignerCkbPublicKey.getRelatedScripts (AnyoneCanPay) both resolve
      // this unconditionally on every call, just to compare code hashes
      // against the tx's actual input locks. This only needs to resolve to
      // *some* script that isn't one of our test cells' type.
      return ccc.ScriptInfo.from({
        codeHash: "0x" + "00".repeat(32),
        hashType: "type",
        cellDeps: [],
      });
    }
    throw new Error(`FakeClient.getKnownScript: no fixture for ${script}`);
  }

  async getFeeRateStatistics(): Promise<{ mean: ccc.Num; median: ccc.Num }> {
    return { mean: this.feeRate, median: this.feeRate };
  }

  async getTip(): Promise<ccc.Num> {
    return this.tipNumber;
  }

  async getTipHeader(): Promise<ccc.ClientBlockHeader> {
    const header = this.headers.get(`n:${this.tipNumber}`);
    if (!header) throw new Error("FakeClient.getTipHeader: no header seeded for tip");
    return header;
  }

  async getBlockByNumberNoCache(): Promise<ccc.ClientBlock | undefined> {
    throw new Error("FakeClient.getBlockByNumberNoCache: not implemented");
  }

  async getBlockByHashNoCache(): Promise<ccc.ClientBlock | undefined> {
    throw new Error("FakeClient.getBlockByHashNoCache: not implemented");
  }

  async getHeaderByNumberNoCache(
    blockNumber: ccc.NumLike,
  ): Promise<ccc.ClientBlockHeader | undefined> {
    return this.headers.get(`n:${ccc.numFrom(blockNumber)}`);
  }

  async getHeaderByHashNoCache(blockHash: ccc.HexLike): Promise<ccc.ClientBlockHeader | undefined> {
    return this.headers.get(`h:${ccc.hexFrom(blockHash)}`);
  }

  async estimateCycles(): Promise<ccc.Num> {
    return 0n;
  }

  async sendTransactionDry(): Promise<ccc.Num> {
    return 0n;
  }

  async sendTransactionNoCache(transactionLike: ccc.TransactionLike): Promise<ccc.Hex> {
    const tx = ccc.Transaction.from(transactionLike);
    const txHash = tx.hash();

    // Mirrors a real node's `TransactionFailedToResolve`: an input
    // referencing an outpoint that isn't currently live (already spent, or
    // never existed) must reject, not silently succeed — callers that build
    // a tx against a stale/dead cell (e.g. a caching bug) need this to fail
    // the same way it would against a real devnet.
    for (const input of tx.inputs) {
      if (!this.liveCells.has(outPointKey(input.previousOutput))) {
        throw new Error(
          `FakeClient.sendTransactionNoCache: input references a dead or unknown outpoint ${JSON.stringify(input.previousOutput)}`,
        );
      }
    }

    for (const input of tx.inputs) {
      this.liveCells.delete(outPointKey(input.previousOutput));
    }
    tx.outputs.forEach((output, i) => {
      const outPoint = ccc.OutPoint.from({ txHash, index: i });
      this.liveCells.set(
        outPointKey(outPoint),
        ccc.Cell.from({ outPoint, cellOutput: output, outputData: tx.outputsData[i] ?? "0x" }),
      );
    });

    this.txs.set(
      txHash,
      ccc.ClientTransactionResponse.from({ transaction: tx, status: "committed" }),
    );
    return txHash;
  }

  async getTransactionNoCache(
    txHashLike: ccc.HexLike,
  ): Promise<ccc.ClientTransactionResponse | undefined> {
    return this.txs.get(ccc.hexFrom(txHashLike));
  }

  async getCellLiveNoCache(outPointLike: ccc.OutPointLike): Promise<ccc.Cell | undefined> {
    return this.liveCells.get(outPointKey(ccc.OutPoint.from(outPointLike)));
  }

  async findCellsPagedNoCache(
    key: ccc.ClientIndexerSearchKeyLike,
  ): Promise<ccc.ClientFindCellsResponse> {
    const parsed = ccc.ClientIndexerSearchKey.from(key);
    const cells = [...this.liveCells.values()].filter((cell) => matches(cell, parsed));
    return { cells, lastCursor: "" };
  }

  findTransactionsPaged(): Promise<never> {
    throw new Error("FakeClient.findTransactionsPaged: not implemented");
  }

  async getCellsCapacity(key: ccc.ClientIndexerSearchKeyLike): Promise<ccc.Num> {
    const parsed = ccc.ClientIndexerSearchKey.from(key);
    return [...this.liveCells.values()]
      .filter((cell) => matches(cell, parsed))
      .reduce((acc, cell) => acc + cell.cellOutput.capacity, 0n);
  }
}

function outPointKey(outPoint: ccc.OutPointLike): string {
  const p = ccc.OutPoint.from(outPoint);
  return `${p.txHash}:${p.index}`;
}

function inHalfOpenRange(value: number, range?: [ccc.Num, ccc.Num]): boolean {
  if (!range) return true;
  return value >= range[0] && value < range[1];
}

function matches(cell: ccc.Cell, key: ccc.ClientIndexerSearchKey): boolean {
  const target = key.scriptType === "lock" ? cell.cellOutput.lock : cell.cellOutput.type;
  if (!target || !target.eq(key.script)) return false;

  const filter = key.filter;
  if (!filter) return true;

  if (filter.script !== undefined) {
    const other = key.scriptType === "lock" ? cell.cellOutput.type : cell.cellOutput.lock;
    if (!other || !other.eq(filter.script)) return false;
  }
  if (!inHalfOpenRange(cell.cellOutput.type?.occupiedSize ?? 0, filter.scriptLenRange))
    return false;
  if (!inHalfOpenRange(ccc.bytesFrom(cell.outputData).length, filter.outputDataLenRange))
    return false;

  return true;
}
