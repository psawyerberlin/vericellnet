import { buildAnchorTx, buildAnchorTxWithTypeId, buildWithdrawTx, ccc } from "chain";
import { decodeManifest, type Manifest } from "core";
import { requireApiKey } from "../auth.js";
import {
  BadGatewayError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ProblemError,
} from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import { buildFullManifest, manifestBytes } from "../manifestDraft.js";
import { getProjectDetail } from "../queries.js";
import { UnidParams } from "../schemas.js";
import { txFromJson, txToJson } from "../txJson.js";
import {
  CustodialAnchorBodySchema,
  PrepareBodySchema,
  SubmitBodySchema,
  type ManifestDraft,
} from "../writeSchemas.js";
import { insertPendingVersion, markProjectWithdrawnPending } from "../writeQueries.js";
import type { TypedApp } from "../build.js";

const CUSTODIAL_TRADEOFF_NOTE =
  "Custodial mode: this proof cell is locked to VeriCell's service wallet, not your own key. " +
  "Authorship is asserted only via manifest.declared_author (no detached signature verification " +
  "yet) — see TECHNICAL.md §7.2-B and §9. This weakens the on-chain ownership property described " +
  "there; prefer non-custodial (POST /proofs/prepare + POST /proofs/submit) when self-custody matters.";

async function resolvePayerLock(
  client: ccc.Client,
  payer: { lock?: ccc.ScriptLike; address?: string },
): Promise<ccc.ScriptLike> {
  if (payer.lock) return payer.lock;
  // PayerSchema's `.refine` guarantees at least one of the two is set.
  const address = await ccc.Address.fromString(payer.address!, client);
  return address.script;
}

function ownerAddressOf(lock: ccc.ScriptLike, addressPrefix: string): string {
  return new ccc.Address(ccc.Script.from(lock), addressPrefix).toString();
}

function requireCustodialEnabled(app: TypedApp): void {
  if (!app.custodialEnabled) {
    throw new ForbiddenError(
      "Custodial mode is disabled on this server (CUSTODIAL_ENABLED not set)",
    );
  }
}

/**
 * Resolves the previous version's on-chain cell for a new-version anchor:
 * validates it's still live, and returns the `genesis`/`prevOutPoint`/
 * `prevTypeScript` a builder needs. Shared by the non-custodial `prepare`
 * and custodial `.../versions` routes.
 */
async function resolvePrevVersion(
  app: TypedApp,
  client: ccc.Client,
  prevTxHash: string,
): Promise<{ genesis: string; prevOutPoint: ccc.OutPointLike; prevTypeScript?: ccc.ScriptLike }> {
  const prevProof = await app.fetchProofFromChain(prevTxHash);
  if (!prevProof.manifest) {
    throw new NotFoundError(`No proof found for prev_tx_hash "${prevTxHash}"`);
  }
  if (prevProof.live !== true) {
    throw new ConflictError(
      `prev_tx_hash "${prevTxHash}" is not a live proof cell (already superseded or withdrawn)`,
    );
  }
  const prevCell = await client.getCell({ txHash: prevTxHash, index: 0 });
  if (!prevCell) {
    throw new NotFoundError(`Could not locate the live cell for "${prevTxHash}"`);
  }
  return {
    genesis: prevProof.manifest.genesis ?? prevTxHash,
    prevOutPoint: prevCell.outPoint,
    prevTypeScript: prevCell.cellOutput.type ?? undefined,
  };
}

async function buildAnchor(
  client: ccc.Client,
  lock: ccc.ScriptLike,
  bytes: Uint8Array,
  prev?: { prevOutPoint: ccc.OutPointLike; prevTypeScript?: ccc.ScriptLike },
): Promise<ccc.Transaction> {
  if (prev?.prevTypeScript) {
    return (
      await buildAnchorTxWithTypeId({
        client,
        lock,
        manifestBytes: bytes,
        prevOutPoint: prev.prevOutPoint,
        prevTypeScript: prev.prevTypeScript,
      })
    ).tx;
  }
  if (prev) {
    return buildAnchorTx({ client, lock, manifestBytes: bytes, prevOutPoint: prev.prevOutPoint });
  }
  // Brand-new project: Type ID by default (TECHNICAL.md §5, "Production").
  return (await buildAnchorTxWithTypeId({ client, lock, manifestBytes: bytes })).tx;
}

function deriveUnid(output0: ccc.CellOutput, manifest: Manifest, txHash: string): string {
  return output0.type ? output0.type.args : (manifest.genesis ?? txHash);
}

export function registerProofRoutes(app: TypedApp): void {
  // --- Non-custodial: the API prepares, the client signs. ---------------

  app.post(
    "/api/v1/proofs/prepare",
    {
      schema: {
        tags: ["proofs"],
        summary: "Build an unsigned anchor transaction for the caller to sign locally",
        body: PrepareBodySchema,
      },
      preHandler: requireApiKey(app),
    },
    async (req, reply) => {
      const apiKeyHash = req.apiKeyHash!;
      return withIdempotency(app.db, req, reply, apiKeyHash, async () => {
        const { manifest: draft, payer, prev_tx_hash } = req.body;
        const client = app.getChainClient();
        const lock = await resolvePayerLock(client, payer);

        const prev = prev_tx_hash ? await resolvePrevVersion(app, client, prev_tx_hash) : undefined;
        const manifest = await buildFullManifest(
          draft as ManifestDraft,
          prev ? { genesis: prev.genesis, prev: prev_tx_hash } : undefined,
        );
        const bytes = manifestBytes(manifest);

        const tx = await buildAnchor(client, lock, bytes, prev);
        const capacity = tx.outputs[0]!.capacity;

        return {
          status: 200,
          body: {
            tx: txToJson(tx),
            capacity: capacity.toString(),
            project_sha256: manifest.project_sha256,
            manifest,
          },
        };
      });
    },
  );

  app.post(
    "/api/v1/proofs/submit",
    {
      schema: {
        tags: ["proofs"],
        summary: "Broadcast a signed anchor transaction",
        body: SubmitBodySchema,
      },
      preHandler: requireApiKey(app),
    },
    async (req, reply) => {
      const apiKeyHash = req.apiKeyHash!;
      return withIdempotency(app.db, req, reply, apiKeyHash, async () => {
        const tx = txFromJson(req.body.tx);

        const output0 = tx.outputs[0];
        const data0 = tx.outputsData[0];
        if (!output0 || data0 === undefined) {
          throw new ProblemError(400, "Bad Request", "Transaction has no output at index 0");
        }

        let manifest: Manifest;
        try {
          manifest = decodeManifest(ccc.bytesFrom(data0));
        } catch (err) {
          throw new ProblemError(
            400,
            "Bad Request",
            `Output 0 data is not a valid VeriCell manifest: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const client = app.getChainClient();
        let txHash: string;
        try {
          txHash = await client.sendTransaction(tx);
        } catch (err) {
          throw new BadGatewayError(
            `Broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const unid = deriveUnid(output0, manifest, txHash);
        insertPendingVersion(app.db, {
          txHash,
          unid,
          manifest,
          ownerAddress: ownerAddressOf(output0.lock, client.addressPrefix),
        });

        return { status: 202, body: { tx_hash: txHash, unid } };
      });
    },
  );

  // --- Custodial: the API signs with a server-held service wallet. ------

  app.post(
    "/api/v1/proofs",
    {
      schema: {
        tags: ["proofs"],
        summary: "Custodial anchor: the service wallet funds, signs and broadcasts",
        body: CustodialAnchorBodySchema,
      },
      preHandler: requireApiKey(app),
    },
    async (req, reply) => {
      requireCustodialEnabled(app);
      const apiKeyHash = req.apiKeyHash!;
      return withIdempotency(app.db, req, reply, apiKeyHash, async () => {
        const client = app.getChainClient();
        const signer = await app.getCustodialSigner();
        const lock = (await signer.getRecommendedAddressObj()).script;

        const manifest = await buildFullManifest(req.body.manifest as ManifestDraft);
        const bytes = manifestBytes(manifest);
        const tx = await buildAnchor(client, lock, bytes);

        const txHash = await signer.sendTransaction(tx);
        const output0 = tx.outputs[0]!;
        const unid = deriveUnid(output0, manifest, txHash);
        insertPendingVersion(app.db, {
          txHash,
          unid,
          manifest,
          ownerAddress: ownerAddressOf(lock, client.addressPrefix),
        });

        return {
          status: 202,
          body: { tx_hash: txHash, unid, note: CUSTODIAL_TRADEOFF_NOTE },
        };
      });
    },
  );

  app.post(
    "/api/v1/proofs/:unid/versions",
    {
      schema: {
        tags: ["proofs"],
        summary: "Custodial new version: consumes the live cell, creates the successor",
        params: UnidParams,
        body: CustodialAnchorBodySchema,
      },
      preHandler: requireApiKey(app),
    },
    async (req, reply) => {
      requireCustodialEnabled(app);
      const apiKeyHash = req.apiKeyHash!;
      return withIdempotency(app.db, req, reply, apiKeyHash, async () => {
        const { unid } = req.params;
        const project = getProjectDetail(app.db, unid);
        if (!project?.active || !project.live_tx_hash) {
          throw new NotFoundError(`No live project with unid "${unid}"`);
        }

        const client = app.getChainClient();
        const signer = await app.getCustodialSigner();
        const serviceLock = (await signer.getRecommendedAddressObj()).script;

        const prevCell = await client.getCell({
          txHash: project.live_tx_hash,
          index: project.live_index,
        });
        if (!prevCell) throw new NotFoundError(`Live cell for "${unid}" not found on chain`);
        if (!prevCell.cellOutput.lock.eq(serviceLock)) {
          throw new ForbiddenError(
            `Project "${unid}" is not owned by the custodial service wallet`,
          );
        }

        const prevProof = await app.fetchProofFromChain(project.live_tx_hash);
        const genesis = prevProof.manifest?.genesis ?? project.live_tx_hash;

        const manifest = await buildFullManifest(req.body.manifest as ManifestDraft, {
          genesis,
          prev: project.live_tx_hash,
        });
        const bytes = manifestBytes(manifest);
        const tx = await buildAnchor(client, serviceLock, bytes, {
          prevOutPoint: prevCell.outPoint,
          prevTypeScript: prevCell.cellOutput.type ?? undefined,
        });

        const txHash = await signer.sendTransaction(tx);
        insertPendingVersion(app.db, {
          txHash,
          unid,
          manifest,
          ownerAddress: ownerAddressOf(serviceLock, client.addressPrefix),
        });

        return { status: 202, body: { tx_hash: txHash, unid, note: CUSTODIAL_TRADEOFF_NOTE } };
      });
    },
  );

  app.delete(
    "/api/v1/proofs/:unid",
    {
      schema: {
        tags: ["proofs"],
        summary: "Custodial withdraw: consumes the live cell, no successor",
        params: UnidParams,
      },
      preHandler: requireApiKey(app),
    },
    async (req, reply) => {
      requireCustodialEnabled(app);
      const apiKeyHash = req.apiKeyHash!;
      return withIdempotency(app.db, req, reply, apiKeyHash, async () => {
        const { unid } = req.params;
        const project = getProjectDetail(app.db, unid);
        if (!project?.active || !project.live_tx_hash) {
          throw new NotFoundError(`No live project with unid "${unid}"`);
        }

        const client = app.getChainClient();
        const signer = await app.getCustodialSigner();
        const serviceLock = (await signer.getRecommendedAddressObj()).script;

        const liveCell = await client.getCell({
          txHash: project.live_tx_hash,
          index: project.live_index,
        });
        if (!liveCell) throw new NotFoundError(`Live cell for "${unid}" not found on chain`);
        if (!liveCell.cellOutput.lock.eq(serviceLock)) {
          throw new ForbiddenError(
            `Project "${unid}" is not owned by the custodial service wallet`,
          );
        }

        const tx = await buildWithdrawTx({
          client,
          lock: serviceLock,
          outPoint: liveCell.outPoint,
        });
        const txHash = await signer.sendTransaction(tx);

        markProjectWithdrawnPending(app.db, unid);

        return {
          status: 202,
          body: {
            tx_hash: txHash,
            unid,
            refund_capacity: tx.outputs[0]!.capacity.toString(),
            note: CUSTODIAL_TRADEOFF_NOTE,
          },
        };
      });
    },
  );
}
