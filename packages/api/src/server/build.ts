import type Database from "better-sqlite3";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RawServerDefault,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { NETWORK, type Network } from "core";
import {
  defaultFetchProof,
  defaultGetTip,
  type FetchProofFn,
  type GetTipFn,
} from "./chainLookup.js";
import {
  defaultGetChainClient,
  defaultGetCustodialSigner,
  resolveCustodialEnabled,
  type GetChainClientFn,
  type GetCustodialSignerFn,
} from "./chainClient.js";
import { perKeyRateLimitOptions } from "./auth.js";
import { problemBody, ProblemError } from "./errors.js";
import { registerHashRoutes } from "./routes/hashes.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerKeyRoutes } from "./routes/keys.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerProofRoutes } from "./routes/proofs.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerVerifyRoutes } from "./routes/verify.js";
import { registerVersionRoutes } from "./routes/versions.js";
import "./types.js";

export type TypedApp = FastifyInstance<
  RawServerDefault,
  FastifyRequest["raw"],
  FastifyReply["raw"],
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface BuildServerOptions {
  db: Database.Database;
  network?: Network;
  fetchProof?: FetchProofFn;
  getTip?: GetTipFn;
  /** Raw chain client for `/proofs*` (tx building, broadcast) — defaults to a lazily-built real `chain.makeClient()`, injectable so tests never need a live connection. */
  chainClient?: GetChainClientFn;
  /** Fastify's own request/response logging (boolean or pino options object). Mutually exclusive with `loggerInstance`. */
  logger?: boolean;
  /** A pre-built logger (e.g. `pino()`) to reuse — see Fastify v5's `loggerInstance` option. Mutually exclusive with `logger`. */
  loggerInstance?: FastifyBaseLogger;
  rateLimit?: { max: number; timeWindow: string | number };
  /** Bearer token guarding `POST /api/v1/keys`. Defaults to the `ADMIN_TOKEN` env var. */
  adminToken?: string;
  /** Feature flag for the custodial `/proofs*` routes (TECHNICAL.md §7.2-B). Defaults to `CUSTODIAL_ENABLED`, gated on mainnet by `MAINNET_CONFIRM` — see `chainClient.ts`. */
  custodialEnabled?: boolean;
  /** Lazily-connected service-wallet signer for custodial mode. Defaults to a `SignerCkbPrivateKey` built from `SERVICE_PRIVATE_KEY`. */
  custodialSigner?: GetCustodialSignerFn;
}

const PROBLEM_JSON = "application/problem+json; charset=utf-8";

function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    reply
      .code(404)
      .type(PROBLEM_JSON)
      .send(problemBody(404, "Not Found", req.url, `No route matches ${req.method} ${req.url}`));
  });

  app.setErrorHandler<FastifyError>((err, req, reply) => {
    if (err instanceof ProblemError) {
      reply.code(err.statusCode).type(PROBLEM_JSON).send({
        type: err.type,
        title: err.title,
        status: err.statusCode,
        detail: err.detail,
        instance: req.url,
      });
      return;
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
      reply
        .code(400)
        .type(PROBLEM_JSON)
        .send(
          problemBody(400, "Bad Request", req.url, "Request validation failed", err.validation),
        );
      return;
    }

    if (isResponseSerializationError(err)) {
      req.log.error({ err }, "response serialization failed");
      reply
        .code(500)
        .type(PROBLEM_JSON)
        .send(problemBody(500, "Internal Server Error", req.url, "Failed to serialize response"));
      return;
    }

    const statusCode = err.statusCode ?? 500;
    if (statusCode === 429) {
      reply
        .code(429)
        .type(PROBLEM_JSON)
        .send(problemBody(429, "Too Many Requests", req.url, err.message));
      return;
    }

    if (statusCode >= 500) {
      req.log.error({ err }, "unhandled error");
    }
    reply
      .code(statusCode)
      .type(PROBLEM_JSON)
      .send(
        problemBody(
          statusCode,
          statusCode >= 500 ? "Internal Server Error" : (err.name ?? "Error"),
          req.url,
          statusCode >= 500 ? "An unexpected error occurred" : err.message,
        ),
      );
  });
}

/**
 * Fastify app factory, separated from the listener (`server/run.ts`) so
 * tests can exercise routes via `inject()` without binding a port.
 * `fetchProof`/`getTip` are injectable so tests never need a live chain
 * connection — see `server/chainLookup.ts`.
 */
export function buildServer(opts: BuildServerOptions): TypedApp {
  const app = Fastify(
    opts.loggerInstance
      ? { loggerInstance: opts.loggerInstance }
      : { logger: opts.logger ?? false },
  ).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const network = opts.network ?? NETWORK;

  app.decorate("db", opts.db);
  app.decorate("network", network);
  app.decorate("fetchProofFromChain", opts.fetchProof ?? defaultFetchProof);
  app.decorate("getChainTip", opts.getTip ?? defaultGetTip);
  app.decorate("getChainClient", opts.chainClient ?? defaultGetChainClient);
  app.decorate("adminToken", opts.adminToken ?? globalThis.process?.env?.ADMIN_TOKEN);
  app.decorate("custodialEnabled", opts.custodialEnabled ?? resolveCustodialEnabled(network));
  app.decorate("getCustodialSigner", opts.custodialSigner ?? defaultGetCustodialSigner);

  void app.register(cors, { origin: true, methods: ["GET", "HEAD", "OPTIONS"] });

  void app.register(rateLimit, {
    global: true,
    max: opts.rateLimit?.max ?? 60,
    timeWindow: opts.rateLimit?.timeWindow ?? "1 minute",
  });

  void app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "VeriCell API",
        description:
          "Proof of authorship, integrity and time for any digital project, anchored on Nervos CKB. Public read-only endpoints — see TECHNICAL.md §7.1.",
        version: "1.0.0",
      },
      tags: [
        { name: "projects", description: "Search and inspect anchored projects" },
        { name: "versions", description: "Individual on-chain proof versions" },
        { name: "hashes", description: "Backward hash search and verification" },
        { name: "meta", description: "Service health and statistics" },
      ],
    },
    transform: jsonSchemaTransform,
  });

  void app.register(swaggerUi, { routePrefix: "/api/v1/docs" });

  registerErrorHandling(app);

  // Routes are registered inside a child plugin so avvio boots them *after*
  // `swagger`'s own registration has run and attached its `onRoute` hook —
  // that hook only sees routes declared from this point in the boot queue
  // onward, so declaring them directly on `app` above (before swagger has
  // actually executed) would silently omit them from the generated spec.
  void app.register(async (instance) => {
    instance.get("/api/v1/openapi.json", { schema: { hide: true } }, async () =>
      instance.swagger(),
    );

    registerProjectRoutes(instance);
    registerVersionRoutes(instance);
    registerHashRoutes(instance);
    registerVerifyRoutes(instance);
    registerStatsRoutes(instance);
    registerHealthRoutes(instance);
    registerKeyRoutes(instance);

    // Own child scope so its per-key rate limiter (distinct from the
    // global per-IP one registered above) only ever applies to the
    // authenticated write routes, per TECHNICAL.md §7.4.
    void instance.register(async (writeScope) => {
      void writeScope.register(rateLimit, {
        global: true,
        timeWindow: opts.rateLimit?.timeWindow ?? "1 minute",
        ...perKeyRateLimitOptions(opts.db),
      });
      registerProofRoutes(writeScope);
    });
  });

  return app;
}
