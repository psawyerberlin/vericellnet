/**
 * Phase 5 acceptance: offckb integration suite for the authenticated write
 * API (`/proofs*`, `/keys`). Reuses the same devnet setup as `chain`'s and
 * the indexer's own offckb suites — see those files' header comments for
 * the full setup steps. In short:
 *
 *   1. `offckb node` (RPC proxy at http://127.0.0.1:28114 by default).
 *   2. `VERICELL_OFFCKB_PRIVATE_KEY` = a funded devnet account's private key.
 *   3. `VERICELL_DEVNET_SCRIPTS_FILE` = path to
 *      `offckb system-scripts --export-style ccc --network devnet` output.
 *   4. `OFFCKB=1 pnpm --filter api test` (or `pnpm --filter api test:offckb`)
 *
 * Skipped entirely unless `OFFCKB=1`. The suite's own service wallet reuses
 * the same funded devnet account as the non-custodial payer (only one is
 * available in this environment) — the two roles are still exercised
 * through entirely separate code paths (payer-signed vs. server-signed).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { ccc } from "@ckb-ccc/ccc";
import { makeClient } from "chain";
import { sha256Hex } from "core";
import { openDb } from "../db/open.js";
import { Indexer } from "../indexer/indexer.js";
import { hashApiKey } from "./auth.js";
import { buildServer, type TypedApp } from "./build.js";

const OFFCKB_ENABLED = globalThis.process?.env?.OFFCKB === "1";
const API_KEY = "vk_offckb_test_key_0123456789abcdef";
const ADMIN_TOKEN = "offckb-admin-token";

interface VersionStatusRow {
  status: string;
}

describe.skipIf(!OFFCKB_ENABLED)("write API against offckb devnet", () => {
  let client: ccc.Client;
  let signer: ccc.SignerCkbPrivateKey;
  let lock: ccc.Script;
  let db: Database.Database;
  let app: TypedApp;
  let indexer: Indexer;
  const runTag = Math.random().toString(36).slice(2, 10);
  const authHeaders = { authorization: `Bearer ${API_KEY}` };

  beforeAll(async () => {
    const privateKey = globalThis.process?.env?.VERICELL_OFFCKB_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error(
        "OFFCKB=1 requires VERICELL_OFFCKB_PRIVATE_KEY to be set to a funded devnet account's private key.",
      );
    }
    if (!globalThis.process?.env?.VERICELL_DEVNET_SCRIPTS_FILE) {
      throw new Error(
        "OFFCKB=1 requires VERICELL_DEVNET_SCRIPTS_FILE (see this file's header comment).",
      );
    }

    client = makeClient("devnet");
    signer = new ccc.SignerCkbPrivateKey(client, privateKey);
    await signer.connect();
    lock = (await signer.getRecommendedAddressObj()).script;

    db = openDb(":memory:");
    db.prepare(
      "INSERT INTO api_keys (key_hash, label, created_at, rate_limit) VALUES (?, ?, ?, ?)",
    ).run(hashApiKey(API_KEY), "offckb-test", new Date().toISOString(), 1000);

    app = buildServer({
      db,
      network: "devnet",
      chainClient: () => client,
      adminToken: ADMIN_TOKEN,
      custodialEnabled: true,
      custodialSigner: async () => signer,
      rateLimit: { max: 1000, timeWindow: "1 minute" },
    });

    indexer = new Indexer({ db, client, startBlock: 0n });
  }, 30000);

  async function manifestDraft(title: string, fileTag: string, extra?: Record<string, unknown>) {
    return {
      title,
      files: [{ p: "file.txt", h: await sha256Hex(new TextEncoder().encode(fileTag)) }],
      ...extra,
    };
  }

  it("401/403 auth failures never reach the chain", async () => {
    const noAuth = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      payload: { manifest: await manifestDraft("x", "x"), payer: { lock } },
    });
    expect(noAuth.statusCode).toBe(401);

    const badKey = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: "Bearer vk_not_real" },
      payload: { manifest: await manifestDraft("x", "x"), payer: { lock } },
    });
    expect(badKey.statusCode).toBe(401);

    const badAdmin = await app.inject({ method: "POST", url: "/api/v1/keys", payload: {} });
    expect(badAdmin.statusCode).toBe(401);
  });

  it("non-custodial: prepare -> sign locally -> submit -> indexer flips pending to committed", async () => {
    const draft = await manifestDraft(`Phase5 NC ${runTag}`, `${runTag}:nc`);

    const prepareRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: authHeaders,
      payload: { manifest: draft, payer: { lock } },
    });
    expect(prepareRes.statusCode).toBe(200);
    const prepared = prepareRes.json();
    expect(prepared.project_sha256).toMatch(/^[0-9a-f]{64}$/);

    const unsignedTx = ccc.Transaction.from(prepared.tx as ccc.TransactionLike);
    const signedTx = await signer.signTransaction(unsignedTx);
    const txJson = JSON.parse(ccc.stringify(signedTx)) as unknown;

    const submitRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: authHeaders,
      payload: { tx: txJson },
    });
    expect(submitRes.statusCode).toBe(202);
    const { tx_hash: txHash, unid } = submitRes.json();
    expect(unid).toBeTruthy();

    const pendingRow = db.prepare("SELECT status FROM versions WHERE tx_hash = ?").get(txHash) as
      VersionStatusRow | undefined;
    expect(pendingRow?.status).toBe("pending");

    await client.waitTransaction(txHash);
    await indexer.pollOnce();

    const committedRow = db.prepare("SELECT status FROM versions WHERE tx_hash = ?").get(txHash) as
      VersionStatusRow | undefined;
    expect(committedRow?.status).toBe("committed");

    const projectRow = db.prepare("SELECT active, unid FROM projects WHERE unid = ?").get(unid) as
      { active: number; unid: string } | undefined;
    expect(projectRow?.active).toBe(1);
  }, 90000);

  it("idempotent replay: a repeated Idempotency-Key never double-broadcasts", async () => {
    const draft = await manifestDraft(`Phase5 Idem ${runTag}`, `${runTag}:idem`);

    const prepareRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: authHeaders,
      payload: { manifest: draft, payer: { lock } },
    });
    const prepared = prepareRes.json();
    const unsignedTx = ccc.Transaction.from(prepared.tx as ccc.TransactionLike);
    const signedTx = await signer.signTransaction(unsignedTx);
    const txJson = JSON.parse(ccc.stringify(signedTx)) as unknown;

    const idemHeaders = { ...authHeaders, "idempotency-key": `idem-${runTag}` };

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: idemHeaders,
      payload: { tx: txJson },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: idemHeaders,
      payload: { tx: txJson },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());

    const versionCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM versions WHERE tx_hash = ?")
        .get(first.json().tx_hash) as {
        n: number;
      }
    ).n;
    expect(versionCount).toBe(1);

    await client.waitTransaction(first.json().tx_hash);
  }, 60000);

  it("custodial: anchor, new version, withdraw", async () => {
    const anchorRes = await app.inject({
      method: "POST",
      url: "/api/v1/proofs",
      headers: authHeaders,
      payload: {
        manifest: await manifestDraft(`Phase5 Custodial ${runTag}`, `${runTag}:cust1`, {
          declared_author: "phase5-offckb-suite",
        }),
      },
    });
    expect(anchorRes.statusCode).toBe(202);
    const anchorBody = anchorRes.json();
    expect(anchorBody.note).toMatch(/custodial/i);
    await client.waitTransaction(anchorBody.tx_hash);

    const versionRes = await app.inject({
      method: "POST",
      url: `/api/v1/proofs/${anchorBody.unid}/versions`,
      headers: authHeaders,
      payload: {
        manifest: await manifestDraft(`Phase5 Custodial v2 ${runTag}`, `${runTag}:cust2`, {
          declared_author: "phase5-offckb-suite",
        }),
      },
    });
    expect(versionRes.statusCode).toBe(202);
    const versionBody = versionRes.json();
    expect(versionBody.unid).toBe(anchorBody.unid);
    expect(versionBody.tx_hash).not.toBe(anchorBody.tx_hash);
    await client.waitTransaction(versionBody.tx_hash);

    const withdrawRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/proofs/${anchorBody.unid}`,
      headers: authHeaders,
    });
    expect(withdrawRes.statusCode).toBe(202);
    const withdrawBody = withdrawRes.json();
    expect(BigInt(withdrawBody.refund_capacity)).toBeGreaterThan(0n);
    await client.waitTransaction(withdrawBody.tx_hash);

    await indexer.pollOnce();

    const projectRow = db
      .prepare("SELECT active, live_tx_hash FROM projects WHERE unid = ?")
      .get(anchorBody.unid) as { active: number; live_tx_hash: string | null } | undefined;
    expect(projectRow?.active).toBe(0);
  }, 120000);
});
