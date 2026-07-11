import { ManifestSchema, encodeManifest, merkleRoot, projectHash, type Manifest } from "core";
import type { ManifestDraft } from "./writeSchemas.js";

/**
 * Turn a caller-supplied draft into a full, validated on-chain manifest:
 * computes `project_sha256`/`merkle_root`/`count` from `files` (the server
 * never trusts a caller-supplied hash of the file list — TECHNICAL.md §3
 * defines these as reproducible from the files alone), fills `created` if
 * omitted, and applies `extra` (`genesis`/`prev` for a new version).
 */
export async function buildFullManifest(
  draft: ManifestDraft,
  extra?: Pick<Manifest, "genesis" | "prev" | "declared_author">,
): Promise<Manifest> {
  const entries = draft.files.map((f) => ({ path: f.p, hash: f.h }));
  const project_sha256 = await projectHash(entries);
  const merkle_root = await merkleRoot(entries);

  const manifest: Manifest = {
    app: "vericell",
    v: 1,
    title: draft.title,
    created: draft.created ?? new Date().toISOString(),
    ...(draft.source !== undefined ? { source: draft.source } : {}),
    project_sha256,
    merkle_root,
    count: entries.length,
    ...(draft.compact ? {} : { files: draft.files }),
    ...extra,
  };

  return ManifestSchema.parse(manifest);
}

export function manifestBytes(manifest: Manifest): Uint8Array {
  return encodeManifest(manifest);
}
