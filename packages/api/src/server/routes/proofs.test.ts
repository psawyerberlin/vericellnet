import { beforeEach, describe, expect, it } from "vitest";
import { ccc, FakeClient } from "chain";
import { openDb } from "../../db/open.js";
import { hashApiKey } from "../auth.js";
import { buildServer, type TypedApp } from "../build.js";
import type { GetCustodialSignerFn } from "../chainClient.js";

// A fixed test-only private key — never used for anything but FakeClient
// fixtures. FakeClient doesn't verify witness signatures, so its exact
// value is irrelevant beyond deriving a stable lock/address.
const PAYER_PRIVATE_KEY = "0x" + "ab".repeat(32);
const SERVICE_PRIVATE_KEY = "0x" + "cd".repeat(32);

const API_KEY = "vk_test_0123456789abcdef0123456789abcdef";
const API_KEY_HASH = hashApiKey(API_KEY);
const ADMIN_TOKEN = "admin-secret-test-token";

function seedWalletCapacity(
  client: FakeClient,
  lock: ccc.ScriptLike,
  txHash: string,
  capacityCkb: number,
): ccc.Cell {
  return client.addLiveCell({
    outPoint: { txHash, index: 0 },
    cellOutput: { capacity: ccc.fixedPointFrom(capacityCkb), lock },
    outputData: "0x",
  });
}

interface Setup {
  app: TypedApp;
  client: FakeClient;
  payerLock: ccc.Script;
  payerSigner: ccc.SignerCkbPrivateKey;
}

async function setup(opts: { custodialEnabled?: boolean } = {}): Promise<Setup> {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO api_keys (key_hash, label, created_at, rate_limit) VALUES (?, ?, ?, ?)",
  ).run(API_KEY_HASH, "test", new Date().toISOString(), 1000);

  const client = new FakeClient();

  const payerSigner = new ccc.SignerCkbPrivateKey(client, PAYER_PRIVATE_KEY);
  await payerSigner.connect();
  const payerLock = (await payerSigner.getRecommendedAddressObj()).script;
  seedWalletCapacity(client, payerLock, "0x" + "11".repeat(32), 100_000);

  const custodialSigner: GetCustodialSignerFn = async () => {
    const signer = new ccc.SignerCkbPrivateKey(client, SERVICE_PRIVATE_KEY);
    await signer.connect();
    return signer;
  };
  const serviceLock = (await (await custodialSigner()).getRecommendedAddressObj()).script;
  seedWalletCapacity(client, serviceLock, "0x" + "22".repeat(32), 100_000);

  const app = buildServer({
    db,
    network: "devnet",
    chainClient: () => client,
    adminToken: ADMIN_TOKEN,
    custodialEnabled: opts.custodialEnabled ?? false,
    custodialSigner,
    rateLimit: { max: 1000, timeWindow: "1 minute" },
  });

  return { app, client, payerLock, payerSigner };
}

const MANIFEST_DRAFT = {
  title: "Test Project",
  files: [{ p: "a.txt", h: "a".repeat(64) }],
};

describe("POST /api/v1/proofs/prepare", () => {
  let ctx: Setup;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("401s without a bearer key", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      payload: { manifest: MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("401s with an unrecognized key", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: "Bearer vk_not_a_real_key" },
      payload: { manifest: MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns an unsigned tx, capacity, and computed project_sha256", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tx.outputs.length).toBeGreaterThanOrEqual(1);
    expect(body.tx.outputs[0].lock.args).toBe(ctx.payerLock.args);
    expect(typeof body.capacity).toBe("string");
    expect(BigInt(body.capacity)).toBeGreaterThan(0n);
    expect(body.project_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.manifest.title).toBe("Test Project");
    // First version, no prev_tx_hash: Type ID by default (TECHNICAL.md §5).
    expect(body.tx.outputs[0].type).toBeDefined();
  });

  it("400s on a malformed body (missing files)", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: { title: "x", files: [] }, payer: { lock: ctx.payerLock } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/proofs/submit", () => {
  let ctx: Setup;
  beforeEach(async () => {
    ctx = await setup();
  });

  async function prepareAndSign(): Promise<{ txJson: unknown; projectSha256: string }> {
    const prepareRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/prepare",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: MANIFEST_DRAFT, payer: { lock: ctx.payerLock } },
    });
    expect(prepareRes.statusCode).toBe(200);
    const prepared = prepareRes.json();

    const unsignedTx = ccc.Transaction.from(prepared.tx as ccc.TransactionLike);
    const signedTx = await ctx.payerSigner.signTransaction(unsignedTx);
    return {
      txJson: JSON.parse(ccc.stringify(signedTx)) as unknown,
      projectSha256: prepared.project_sha256,
    };
  }

  it("401s without a bearer key", async () => {
    const { txJson } = await prepareAndSign();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      payload: { tx: txJson },
    });
    expect(res.statusCode).toBe(401);
  });

  it("broadcasts the signed tx and inserts a pending version", async () => {
    const { txJson, projectSha256 } = await prepareAndSign();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { tx: txJson },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.unid).toBeTruthy();

    const dbRow = ctx.app.db
      .prepare("SELECT status, project_sha256 FROM versions WHERE tx_hash = ?")
      .get(body.tx_hash) as { status: string; project_sha256: string } | undefined;
    expect(dbRow?.status).toBe("pending");
    expect(dbRow?.project_sha256).toBe(projectSha256);

    const projectRow = ctx.app.db
      .prepare("SELECT active, live_tx_hash FROM projects WHERE unid = ?")
      .get(body.unid) as { active: number; live_tx_hash: string } | undefined;
    expect(projectRow?.active).toBe(1);
    expect(projectRow?.live_tx_hash).toBe(body.tx_hash);
  });

  it("400s on an invalid transaction payload", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { tx: { not: "a transaction" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("Idempotency-Key replay returns the stored response without re-broadcasting", async () => {
    const { txJson } = await prepareAndSign();
    const idemHeaders = {
      authorization: `Bearer ${API_KEY}`,
      "idempotency-key": "replay-test-1",
    };

    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: idemHeaders,
      payload: { tx: txJson },
    });
    expect(first.statusCode).toBe(202);

    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs/submit",
      headers: idemHeaders,
      payload: { tx: txJson },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());

    const versionCount = (
      ctx.app.db.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number }
    ).n;
    expect(versionCount).toBe(1);
  });
});

describe("custodial proofs (CUSTODIAL_ENABLED)", () => {
  it("403s when custodial mode is disabled", async () => {
    const ctx = await setup({ custodialEnabled: false });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: { ...MANIFEST_DRAFT, declared_author: "alice" } },
    });
    expect(res.statusCode).toBe(403);
  });

  it("400s when declared_author is missing", async () => {
    const ctx = await setup({ custodialEnabled: true });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { manifest: MANIFEST_DRAFT },
    });
    expect(res.statusCode).toBe(400);
  });

  it("anchors, adds a new version, and withdraws end to end", async () => {
    const ctx = await setup({ custodialEnabled: true });
    const authHeaders = { authorization: `Bearer ${API_KEY}` };

    const anchorRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/proofs",
      headers: authHeaders,
      payload: { manifest: { ...MANIFEST_DRAFT, declared_author: "alice" } },
    });
    expect(anchorRes.statusCode).toBe(202);
    const anchorBody = anchorRes.json();
    expect(anchorBody.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(anchorBody.note).toMatch(/custodial/i);
    const { unid } = anchorBody;

    const versionRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/proofs/${unid}/versions`,
      headers: authHeaders,
      payload: {
        manifest: {
          title: "Test Project v2",
          files: [{ p: "a.txt", h: "b".repeat(64) }],
          declared_author: "alice",
        },
      },
    });
    expect(versionRes.statusCode).toBe(202);
    const versionBody = versionRes.json();
    expect(versionBody.unid).toBe(unid);
    expect(versionBody.tx_hash).not.toBe(anchorBody.tx_hash);

    const withdrawRes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/proofs/${unid}`,
      headers: authHeaders,
    });
    expect(withdrawRes.statusCode).toBe(202);
    const withdrawBody = withdrawRes.json();
    expect(withdrawBody.unid).toBe(unid);
    expect(BigInt(withdrawBody.refund_capacity)).toBeGreaterThan(0n);

    const projectRow = ctx.app.db
      .prepare("SELECT active, live_tx_hash FROM projects WHERE unid = ?")
      .get(unid) as { active: number; live_tx_hash: string | null } | undefined;
    expect(projectRow?.active).toBe(0);
    expect(projectRow?.live_tx_hash).toBeNull();
  });

  it("404s versioning/withdrawing an unknown project", async () => {
    const ctx = await setup({ custodialEnabled: true });
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/proofs/does-not-exist",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/v1/keys", () => {
  let ctx: Setup;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("401s without an admin token", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/v1/keys", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("401s with the wrong admin token", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: { authorization: "Bearer wrong-token" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("mints a key shown once, stored only as a hash", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { label: "ci-bot", rate_limit: 120 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toMatch(/^vk_[0-9a-f]{64}$/);
    expect(body.key_hash).toBe(hashApiKey(body.key));
    expect(body.label).toBe("ci-bot");
    expect(body.rate_limit).toBe(120);

    const row = ctx.app.db
      .prepare("SELECT key_hash, label, rate_limit FROM api_keys WHERE key_hash = ?")
      .get(body.key_hash) as { key_hash: string; label: string; rate_limit: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.label).toBe("ci-bot");
    expect(row?.rate_limit).toBe(120);
  });

  it("Idempotency-Key replay returns the same minted key, not a new one", async () => {
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "keys-replay-1" };
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers,
      payload: {},
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers,
      payload: {},
    });
    expect(first.json()).toEqual(second.json());

    const count = (ctx.app.db.prepare("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number })
      .n;
    expect(count).toBe(2); // the fixture key from setup() + the one minted above
  });
});
