import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

function page(name) {
  return fileURLToPath(new URL(name, import.meta.url));
}

/**
 * Dev-server-only historyApiFallback for the phase-3 deep-link routes:
 * /verify, /verify/*, /status, /status/* all need to serve verify.html's
 * bundle so `vite dev` can test them without Docker/Caddy. In production
 * the equivalent rewrite lives in the Caddyfile (`handle /verify /verify/*
 * /status /status/* { try_files {path} /verify.html }`) — this plugin is
 * the same rule for `vite dev`/`vite preview`, nothing more.
 */
function verifyRoutesFallback() {
  return {
    name: "vericell-verify-routes-fallback",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0];
        if (path && /^\/(verify|status)(\/|$)/.test(path)) {
          req.url = "/verify.html";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  server: {
    host: true,
  },
  plugins: [verifyRoutesFallback()],
  build: {
    // Static multi-page build: the SPA plus the German legal pages
    // (phase 10b) and the read-only /verify page (phase 3) linked from the
    // footer/nav — each is a standalone HTML entry so it gets the same
    // processed/hashed `style.css` as index.html.
    rollupOptions: {
      input: {
        main: page("index.html"),
        verify: page("verify.html"),
        impressum: page("impressum.html"),
        datenschutz: page("datenschutz.html"),
        haftungsausschluss: page("haftungsausschluss.html"),
      },
      output: {
        // pdf-lib (and its pdf-lib-exclusive deps) is only ever reached through
        // the dynamic import() in certificate.js's PDF renderer — pin it to its
        // own chunk so it can't get fused into the certificate.js chunk that
        // main.js/verify.js already load eagerly (Rollup's default chunking
        // will otherwise merge a dynamic-import-only dependency into whatever
        // chunk its sole importer already belongs to). `tslib` is deliberately
        // excluded — it's a shared helper pulled in by @ckb-ccc/ccc too, and
        // forcing it in here would drag this chunk into the eager index bundle.
        //
        // Supplying *any* manualChunks function replaces Vite's own default
        // vendor-splitting entirely, not just for the modules matched here —
        // without the @ckb-ccc/ccc line below, that large wallet SDK (reached
        // eagerly from both entries via search.js) falls back into the same
        // shared chunk as certificate.js instead of staying in its own chunk,
        // which would make verify.html's read-only page load it needlessly.
        manualChunks(id) {
          if (/node_modules\/(pdf-lib|@pdf-lib|pako)\//.test(id)) {
            return "pdf-lib";
          }
          if (/node_modules\/@ckb-ccc\//.test(id)) {
            return "ckb-ccc";
          }
        },
      },
    },
  },
});
