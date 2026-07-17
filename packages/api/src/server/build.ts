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
  makeDefaultFetchProof,
  makeDefaultGetTip,
  type FetchProofFn,
  type GetTipFn,
} from "./chainLookup.js";
import { makeDefaultGetChainClient, type GetChainClientFn } from "./chainClient.js";
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
import { registerWebhookRoutes } from "./routes/webhooks.js";
import "./types.js";

export type TypedApp = FastifyInstance<
  RawServerDefault,
  FastifyRequest["raw"],
  FastifyReply["raw"],
  FastifyBaseLogger,
  ZodTypeProvider
>;

/**
 * Everything one network needs to serve its own route tree (Phase 10a):
 * its own network-scoped SQLite DB and, optionally, its own chain lookups.
 * Any field left unset falls back to a real network-scoped default, exactly
 * like the top-level `BuildServerOptions` fields did pre-10a.
 */
export interface NetworkBinding {
  db: Database.Database;
  fetchProof?: FetchProofFn;
  getTip?: GetTipFn;
  /** Raw chain client for `/proofs*` (tx building, broadcast) — defaults to a lazily-built real `chain.makeClient(network)`, injectable so tests never need a live connection. */
  chainClient?: GetChainClientFn;
}

export interface BuildServerOptions {
  // Single-network fields (Phases 3-9): equivalent to a one-entry `networks`
  // map keyed by `network` (or the process-default `NETWORK`) — kept as-is
  // so every existing caller/test needs no changes. See `defaultNetwork`.
  db?: Database.Database;
  network?: Network;
  fetchProof?: FetchProofFn;
  getTip?: GetTipFn;
  chainClient?: GetChainClientFn;

  /**
   * Phase 10a: additional network-scoped bindings. Every network present
   * here (plus the one derived from the legacy `db`/`network` fields above,
   * if given) is mounted at its own `/api/v1/<network>/...` route tree,
   * each bound to its own DB and chain client — a single deployment serving
   * both testnet and mainnet passes `{ testnet: {...}, mainnet: {...} }`.
   */
  networks?: Partial<Record<Network, NetworkBinding>>;
  /**
   * Which network the bare `/api/v1/...` alias serves (TECHNICAL.md/
   * ClaudeCodeInstruction.md: "keep /api/v1/... as an alias for the DEFAULT
   * network so the existing CLI, tests and docs keep working"). Defaults to
   * `network` (legacy field) or `core`'s `NETWORK`. Must have a binding —
   * from `networks`, or from `db`/`network` above.
   */
  defaultNetwork?: Network;

  /** Fastify's own request/response logging (boolean or pino options object). Mutually exclusive with `loggerInstance`. */
  logger?: boolean;
  /** A pre-built logger (e.g. `pino()`) to reuse — see Fastify v5's `loggerInstance` option. Mutually exclusive with `logger`. */
  loggerInstance?: FastifyBaseLogger;
  rateLimit?: { max: number; timeWindow: string | number };
  /** Bearer token guarding `POST /api/v1/keys` (shared across every mounted network — key *minting privilege* is server-wide; the keys themselves are still per-network rows in each network's own DB). Defaults to the `ADMIN_TOKEN` env var. */
  adminToken?: string;
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

  const defaultNetwork = opts.defaultNetwork ?? opts.network ?? NETWORK;

  // The legacy single-network fields become the `defaultNetwork` entry of
  // `networks`, unless that entry was already given explicitly — so every
  // pre-10a caller (a single `db`/`network`) keeps working unchanged, and
  // Phase 10a callers pass `networks` (optionally alongside `db`, for a
  // third, non-default network) instead.
  const networks: Partial<Record<Network, NetworkBinding>> = { ...opts.networks };
  if (opts.db && !networks[defaultNetwork]) {
    networks[defaultNetwork] = {
      db: opts.db,
      fetchProof: opts.fetchProof,
      getTip: opts.getTip,
      chainClient: opts.chainClient,
    };
  }
  const defaultBinding = networks[defaultNetwork];
  if (!defaultBinding) {
    throw new Error(
      `buildServer: no database binding for default network "${defaultNetwork}" — pass "db" or "networks.${defaultNetwork}"`,
    );
  }
  const mountedNetworks = Object.keys(networks) as Network[];

  app.decorate("adminToken", opts.adminToken ?? globalThis.process?.env?.ADMIN_TOKEN);

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
        title: "VeriCell.net API",
        description:
          "Proof of authorship, integrity and time for any digital project, anchored on Nervos CKB. Public read-only endpoints — see TECHNICAL.md §7.1.",
        version: "1.1.0",
      },
      // Phase 10a: every network is mounted at its own /api/v1/<network>/...
      // tree; the un-prefixed entry documents the alias every route is also
      // reachable at (ClaudeCodeInstruction.md: "keep /api/v1/... as an
      // alias for the DEFAULT network") and, listed first, is also the one
      // `@fastify/swagger` uses to compute each route's documented path
      // (it strips only `servers[0].url`) — the templated entry after it
      // documents the network path parameter without disturbing that.
      // (Swapping this order would make swagger substitute the template's
      // *default* value and strip that instead, which — whenever the
      // default network's own prefix happens to match — silently merges
      // that network's paths into the alias's, dropping them from the spec.)
      servers: [
        {
          url: "/api/v1",
          description:
            mountedNetworks.length > 1
              ? `Alias for the default network (${defaultNetwork})`
              : `VeriCell.net API (${defaultNetwork})`,
        },
        ...(mountedNetworks.length > 1
          ? [
              {
                url: "/api/v1/{network}",
                variables: { network: { enum: mountedNetworks, default: defaultNetwork } },
              },
            ]
          : []),
      ],
      tags: [
        { name: "projects", description: "Search and inspect anchored projects" },
        { name: "versions", description: "Individual on-chain proof versions" },
        { name: "hashes", description: "Backward hash search and verification" },
        { name: "meta", description: "Service health and statistics" },
        { name: "proofs", description: "Authenticated anchoring and withdrawal (non-custodial)" },
        { name: "keys", description: "API key management" },
        { name: "webhooks", description: "Event delivery for committed/consumed/superseded" },
      ],
    },
    transform: jsonSchemaTransform,
  });

  void app.register(swaggerUi, { routePrefix: "/api/v1/docs" });

  registerErrorHandling(app);

  // Every configured network's db + tip lookup, so /health and /stats on
  // the network-less alias scope can report every mounted network, not
  // just the default one (ClaudeCodeInstruction.md: "aliased root shows
  // both"). Built once, up front, so every network's `getTip` fallback is
  // resolved consistently whether or not that network ends up being the
  // default.
  const networkBindingsForAlias: Record<string, { db: Database.Database; getTip: GetTipFn }> = {};
  for (const network of mountedNetworks) {
    const binding = networks[network]!;
    networkBindingsForAlias[network] = {
      db: binding.db,
      getTip: binding.getTip ?? makeDefaultGetTip(network),
    };
  }

  /**
   * Decorates a scope with a single network's bindings. Fastify's
   * per-`register()` encapsulation means a child scope's `decorate()` calls
   * shadow (never clash with) whatever its parent already decorated, so
   * calling this once on the top-level `app` (keeping `app.db`/`app.network`
   * etc. working exactly as pre-10a, since plenty of tests read them
   * directly) and again inside each `/api/v1/<network>/...` child scope
   * gives every scope its own, independent view — sibling mounts never see
   * each other's database or chain client.
   */
  function decorateNetwork(
    scope: TypedApp,
    network: Network,
    binding: NetworkBinding,
    withCrossNetworkBindings = false,
  ): void {
    scope.decorate("db", binding.db);
    scope.decorate("network", network);
    scope.decorate("fetchProofFromChain", binding.fetchProof ?? makeDefaultFetchProof(network));
    scope.decorate("getChainTip", binding.getTip ?? makeDefaultGetTip(network));
    scope.decorate("getChainClient", binding.chainClient ?? makeDefaultGetChainClient(network));
    // Only the network-less alias scope (and, for a consistent top-level
    // `app`, its own mirror of it) gets to see every network's bindings —
    // the prefixed `/api/v1/<network>/...` scopes report only their own
    // network, matching pre-10a `/health`/`/stats` behavior exactly.
    if (withCrossNetworkBindings) {
      scope.decorate("networkBindings", networkBindingsForAlias);
    }
  }

  /** Mounts the full public + authenticated route tree on an already-decorated scope. */
  function registerNetworkRoutes(scope: TypedApp, binding: NetworkBinding): void {
    registerProjectRoutes(scope);
    registerVersionRoutes(scope);
    registerHashRoutes(scope);
    registerVerifyRoutes(scope);
    registerStatsRoutes(scope);
    registerHealthRoutes(scope);
    registerKeyRoutes(scope);

    // Own child scope so its per-key rate limiter (distinct from the
    // global per-IP one registered above) only ever applies to the
    // authenticated write routes, per TECHNICAL.md §7.4.
    void scope.register(async (writeScope) => {
      void writeScope.register(rateLimit, {
        global: true,
        timeWindow: opts.rateLimit?.timeWindow ?? "1 minute",
        ...perKeyRateLimitOptions(binding.db),
      });
      registerProofRoutes(writeScope);
      registerWebhookRoutes(writeScope);
    });
  }

  // `withCrossNetworkBindings` stays false here: fastify's decorators are
  // inherited down the whole prototype chain, so setting `networkBindings`
  // on the top-level `app` would leak into *every* child scope, including
  // the network-prefixed ones that must only ever report their own single
  // network — only the alias scope below actually gets it.
  decorateNetwork(app, defaultNetwork, defaultBinding);

  // Routes are registered inside a child plugin so avvio boots them *after*
  // `swagger`'s own registration has run and attached its `onRoute` hook —
  // that hook only sees routes declared from this point in the boot queue
  // onward, so declaring them directly on `app` above (before swagger has
  // actually executed) would silently omit them from the generated spec.
  void app.register(async (instance) => {
    instance.get("/api/v1/openapi.json", { schema: { hide: true } }, async () =>
      instance.swagger(),
    );

    // Phase 10a: every configured network gets its own /api/v1/<network>/...
    // tree, bound to its own db/chain client.
    for (const network of mountedNetworks) {
      const binding = networks[network]!;
      void instance.register(
        async (netScope) => {
          decorateNetwork(netScope, network, binding);
          registerNetworkRoutes(netScope, binding);
        },
        { prefix: `/api/v1/${network}` },
      );
    }

    // The bare /api/v1/... alias for the default network — unprefixed so
    // the existing CLI, tests and docs (all written pre-10a) keep working
    // unmodified.
    void instance.register(
      async (aliasScope) => {
        decorateNetwork(aliasScope, defaultNetwork, defaultBinding, true);
        registerNetworkRoutes(aliasScope, defaultBinding);
      },
      { prefix: "/api/v1" },
    );
  });

  return app;
}
