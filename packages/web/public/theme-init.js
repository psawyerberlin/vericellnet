/**
 * VeriCell — theme pre-paint init (phase 7).
 *
 * Loaded as a blocking classic <script> (not `type="module"`, which defers)
 * in <head>, before style.css, so `data-theme` is on <html> before first
 * paint — no light-mode flash on a dark-preferring/dark-persisted visit.
 * Byte-identical across all five HTML entries (main, verify, and the three
 * legal pages) rather than five diverging inline copies; src/theme.js does
 * the rest (toggle wiring, persistence) once the DOM/module scripts run.
 */
(function () {
  var KEY = "vericell:theme";
  var stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch (e) {
    /* localStorage unavailable — fall through to prefers-color-scheme */
  }
  var theme =
    stored === "light" || stored === "dark"
      ? stored
      : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.setAttribute("data-theme", theme);
})();
