/**
 * VeriCell — dark/light theme toggle (phase 7).
 *
 * `data-theme` on <html> is already set pre-paint by public/theme-init.js
 * (loaded as a blocking <script> in every entry's <head>). This module only
 * wires the #themeToggle button: clicking it flips the theme and persists
 * the explicit choice to localStorage — same pattern as NETWORK_STORAGE_KEY
 * in search.js — overriding prefers-color-scheme from then on.
 *
 * Self-wiring on import so every entry (main.js, verify.js, and the legal
 * pages, which load this directly as a <script type="module">) gets the
 * same behavior without each caller repeating the wiring.
 */
const THEME_STORAGE_KEY = "vericell:theme";

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function reflectToggle(theme) {
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  const next = theme === "dark" ? "light" : "dark";
  btn.setAttribute("aria-label", `Switch to ${next} theme`);
  btn.title = `Switch to ${next} theme`;
  btn.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  reflectToggle(theme);
}

function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* localStorage unavailable — the toggle still works for this page load */
  }
}

function wireThemeToggle() {
  reflectToggle(currentTheme());
  document.getElementById("themeToggle")?.addEventListener("click", toggleTheme);
}

wireThemeToggle();
