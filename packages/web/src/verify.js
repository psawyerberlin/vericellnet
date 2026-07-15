/**
 * VeriCell — /verify: a standalone, read-only verification page (phase 3).
 *
 * No wallet, no create panel, no fee copy — just look a proof up by file
 * hash, CKB address, transaction hash, or project UNID. Deep-linkable via
 * three canonical, bookmarkable routes (parsed from `location.pathname`,
 * no router library):
 *
 *   /verify                    — bare search landing page
 *   /status/unid/<unid>        — one project's status, straight to its detail view
 *   /status/lock/<ckb-address> — every project anchored by that address
 *   /status/hash/<sha256>      — backward hash search
 *
 * All search/API/rendering machinery is shared with main.js via ./search.js
 * — this file only adds the read-only routing/glue specific to this page.
 */
import { sha256Hex } from "core";
import {
  resolveInitialNetwork,
  makeChainClient,
  NETWORK_STORAGE_KEY,
  renderNetworkBadge,
  wireNetworkSwitch,
  wireApiNavLink,
  wireDropzone,
  looksLikeAddress,
  looksLikeHex64,
  canonicalStatusUrl,
  copyText,
  runSearch,
  showProjectDetail,
} from "./search.js";
import { versionCertActionsHtml, wireVersionCertActions } from "./certificate.js";
import "./theme.js";
import "./nav.js";

const state = {
  network: resolveInitialNetwork(),
  client: null,
};
state.client = makeChainClient(state.network);

/** The verify page has no owner (no wallet) — its only "action" is a copy-link
 *  to the canonical `/status/unid/...` URL, shown for any project with a UNID. */
function buildCanonicalActionsHtml(ctx) {
  if (!ctx.unid) return "";
  const url = canonicalStatusUrl(ctx.unid);
  return `
    <code class="hash-code" title="${url}">${url}</code>
    <button class="btn btn-ghost btn-small" type="button" id="copyCanonicalBtn">
      Copy link
    </button>`;
}

function wireCanonicalActions(panel, ctx) {
  if (!ctx.unid) return;
  const btn = panel.querySelector("#copyCanonicalBtn");
  if (!btn) return;
  btn.onclick = () => copyText(canonicalStatusUrl(ctx.unid), btn);
}

function showDetail(rec) {
  if (rec.unid) setPath(`/status/unid/${encodeURIComponent(rec.unid)}`);
  return showProjectDetail({
    rec,
    network: state.network,
    client: state.client,
    buildActionsHtml: buildCanonicalActionsHtml,
    wireActions: wireCanonicalActions,
    buildVersionActionsHtml: versionCertActionsHtml,
    wireVersionActions: wireVersionCertActions,
  });
}

/** Direct `/status/unid/<unid>` deep link — skip the results list, open the detail
 *  view straight away. `txHash`/`index` synthesized from `unid` (v1: a project's UNID
 *  *is* its genesis transaction hash — see TECHNICAL.md) so the chain-only fallback
 *  works too if the global index is unreachable. */
function openDetailByUnid(unid) {
  return showProjectDetail({
    rec: { unid, txHash: unid, index: 0 },
    network: state.network,
    client: state.client,
    buildActionsHtml: buildCanonicalActionsHtml,
    wireActions: wireCanonicalActions,
    buildVersionActionsHtml: versionCertActionsHtml,
    wireVersionActions: wireVersionCertActions,
  });
}

function runVerifySearch(q, opts = {}) {
  return runSearch(state.network, state.client, q, {
    onSelect: showDetail,
    showCanonicalLink: true,
    ...opts,
  });
}

function setPath(path) {
  if (location.pathname + location.search !== path) history.pushState({}, "", path);
}

/** Detects the query's kind, rewrites the URL to its canonical `/status/...` form
 *  (free-text title search has no canonical form, so it stays on plain `/verify`),
 *  then runs the search. Shared between the search box and a `?q=` handoff. */
async function performVerifySearch(qRaw) {
  const q = qRaw.trim();
  if (!q) return;
  if (looksLikeAddress(q)) {
    setPath(`/status/lock/${encodeURIComponent(q)}`);
    await runVerifySearch(q);
  } else if (looksLikeHex64(q)) {
    const hex = q.replace(/^0x/, "").toLowerCase();
    setPath(`/status/hash/${encodeURIComponent(hex)}`);
    await runVerifySearch(hex, { matchedHash: hex });
  } else {
    setPath("/verify");
    await runVerifySearch(q);
  }
}

/** Re-runs whatever the current URL/search box represents — used after a network
 *  switch, since results are network-scoped and must be refetched, not just re-shown. */
async function reRunCurrentView() {
  const handled = await initRoute();
  if (handled) return;
  const q = document.getElementById("searchInput").value.trim();
  if (q) await runVerifySearch(q);
  else document.getElementById("searchResults").innerHTML = "";
}

async function switchNetwork(target) {
  state.network = target;
  try {
    localStorage.setItem(NETWORK_STORAGE_KEY, target);
  } catch {
    /* localStorage unavailable — the switch still works for this page load */
  }
  state.client = makeChainClient(target);
  renderNetworkBadge(target);
  document.getElementById("detail").hidden = true;
  document.getElementById("detailPanel").innerHTML = "";
  await reRunCurrentView();
}

/** Parses `location.pathname` for one of the three `/status/...` deep-link forms and
 *  renders it directly (no results-list step for `/status/unid/...`, since that's
 *  already a single canonical project). Returns whether a route matched. */
async function initRoute() {
  const m = location.pathname.match(/^\/status\/(unid|lock|hash)\/([^/]+)\/?$/);
  if (!m) return false;
  const [, kind, rawParam] = m;
  const param = decodeURIComponent(rawParam);
  document.getElementById("searchInput").value = param;
  if (kind === "unid") await openDetailByUnid(param);
  else await runVerifySearch(param, kind === "hash" ? { matchedHash: param } : {});
  return true;
}

function init() {
  renderNetworkBadge(state.network);
  wireApiNavLink();
  wireNetworkSwitch(() => state.network, switchNetwork);

  document.getElementById("searchBtn").onclick = () => {
    performVerifySearch(document.getElementById("searchInput").value);
  };
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("searchBtn").click();
  });
  wireDropzone(document.getElementById("verifyDrop"), async (files) => {
    const h = await sha256Hex(await files[0].arrayBuffer());
    document.getElementById("searchInput").value = h;
    await performVerifySearch(h);
  });

  window.addEventListener("popstate", () => {
    document.getElementById("detail").hidden = true;
    document.getElementById("detailPanel").innerHTML = "";
    document.getElementById("searchResults").innerHTML = "";
    if (location.pathname === "/verify" || location.pathname === "/") {
      document.getElementById("searchInput").value = "";
    }
    initRoute();
  });

  (async () => {
    const handledByPath = await initRoute();
    if (handledByPath) return;
    const q = new URLSearchParams(location.search).get("q");
    if (q) {
      document.getElementById("searchInput").value = q;
      await performVerifySearch(q);
    }
  })();
}

init();
