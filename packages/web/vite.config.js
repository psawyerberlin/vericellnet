import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

function page(name) {
  return fileURLToPath(new URL(name, import.meta.url));
}

export default defineConfig({
  server: {
    host: true,
  },
  build: {
    // Static multi-page build: the SPA plus the German legal pages
    // (phase 10b) linked from the footer — each is a standalone HTML
    // entry so it gets the same processed/hashed `style.css` as index.html.
    rollupOptions: {
      input: {
        main: page("index.html"),
        impressum: page("impressum.html"),
        datenschutz: page("datenschutz.html"),
        haftungsausschluss: page("haftungsausschluss.html"),
      },
    },
  },
});
