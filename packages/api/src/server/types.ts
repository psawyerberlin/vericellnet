import "fastify";
import type Database from "better-sqlite3";
import type { Network } from "core";
import type { FetchProofFn, GetTipFn } from "./chainLookup.js";
import type { GetChainClientFn, GetCustodialSignerFn } from "./chainClient.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Database.Database;
    network: Network;
    fetchProofFromChain: FetchProofFn;
    getChainTip: GetTipFn;
    getChainClient: GetChainClientFn;
    /** `undefined` when ADMIN_TOKEN isn't configured — `POST /keys` 500s rather than accepting any caller. */
    adminToken: string | undefined;
    custodialEnabled: boolean;
    getCustodialSigner: GetCustodialSignerFn;
  }

  interface FastifyRequest {
    /** Set by `requireApiKey` once the bearer token has been resolved to an `api_keys` row. */
    apiKeyHash?: string;
  }
}
