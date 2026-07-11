import { z } from "zod";
import { ManifestFileSchema } from "core";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const CODE_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ARGS_RE = /^0x([0-9a-fA-F]{2})*$/;

export const ScriptLikeSchema = z.object({
  codeHash: z.string().regex(CODE_HASH_RE, "must be a 0x-prefixed 32-byte hex code hash"),
  hashType: z.enum(["type", "data", "data1", "data2"]),
  args: z.string().regex(ARGS_RE, "must be 0x-prefixed hex"),
});

/**
 * What a caller sends to describe a proof, before the server fills in the
 * fields it alone can compute (`project_sha256`, `merkle_root`, `count`,
 * and — for a new version — `genesis`/`prev`). `files` is required (not
 * optional like the on-chain `ManifestSchema`): the server needs the file
 * hashes to compute `project_sha256`/`merkle_root` itself, per
 * ClaudeCodeInstruction.md Phase 5 ("computed project_sha256"). `compact`
 * controls whether `files` is still embedded in the final on-chain manifest
 * once those are computed (TECHNICAL.md §3's compact mode) — it is never
 * itself a manifest field.
 */
export const ManifestDraftSchema = z.object({
  title: z.string().min(1),
  created: z.string().datetime({ offset: true }).optional(),
  source: z.string().url().optional(),
  files: z.array(ManifestFileSchema).min(1),
  compact: z.boolean().optional(),
});

export type ManifestDraft = z.infer<typeof ManifestDraftSchema>;

/** Custodial anchors must declare an author (TECHNICAL.md §7.2-B): the cell's lock is the service wallet, not the author's own key. */
export const CustodialManifestDraftSchema = ManifestDraftSchema.extend({
  declared_author: z.string().min(1),
});

export type CustodialManifestDraft = z.infer<typeof CustodialManifestDraftSchema>;

export const PayerSchema = z
  .object({
    lock: ScriptLikeSchema.optional(),
    address: z.string().min(1).optional(),
  })
  .refine((v) => v.lock !== undefined || v.address !== undefined, {
    message: "either payer.lock or payer.address is required",
  });

export const PrepareBodySchema = z.object({
  manifest: ManifestDraftSchema,
  payer: PayerSchema,
  prev_tx_hash: z
    .string()
    .regex(TX_HASH_RE, "must be a 0x-prefixed 32-byte hex transaction hash")
    .optional(),
});

export type PrepareBody = z.infer<typeof PrepareBodySchema>;

/** The signed transaction, round-tripped through `ccc.stringify`/`Transaction.from` — see `server/txJson.ts`. */
export const SubmitBodySchema = z.object({
  tx: z.unknown(),
});

export const CustodialAnchorBodySchema = z.object({
  manifest: CustodialManifestDraftSchema,
});

export const CreateKeyBodySchema = z.object({
  label: z.string().min(1).max(200).optional(),
  rate_limit: z.number().int().min(1).max(10_000).optional(),
});
