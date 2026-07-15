/**
 * VeriCell — shared search/verification machinery (phase 3).
 *
 * Everything a page needs to look a proof up — by file hash, CKB address,
 * transaction hash, or project UNID — and render results/detail, without
 * any wallet or create-panel concerns. Used by both `main.js` (the create
 * page, which additionally wires owner-only actions on top of the detail
 * view) and `verify.js` (the read-only `/verify` + `/status/...` page).
 *
 * Network + chain client handling lives here too, since both pages must
 * resolve/persist the same `state.network` (localStorage-backed) the same
 * way — see `resolveInitialNetwork`/`makeChainClient`/`renderNetworkBadge`/
 * `wireNetworkSwitch`.
 */
import { ccc } from "@ckb-ccc/ccc";
import { NETWORK, explorerUrlForNetwork } from "core";

const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

function apiUrlBase(network) {
  return `${API_BASE}/api/v1/${network}`;
}

async function apiFetch(network, path) {
  if (!API_BASE) throw new Error("no API configured (VITE_API_URL unset)");
  const res = await fetch(`${apiUrlBase(network)}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  return res.json();
}

function apiSearchProjects(network, params) {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(network, `/projects?${qs}`);
}
function apiGetProject(network, unid) {
  return apiFetch(network, `/projects/${encodeURIComponent(unid)}`);
}
function apiGetVersion(network, txHash) {
  return apiFetch(network, `/versions/${txHash}`);
}

export function looksLikeHex64(q) {
  return /^(0x)?[a-fA-F0-9]{64}$/.test(q);
}
export function looksLikeAddress(q) {
  return /^ck[bt]1[0-9a-z]+$/i.test(q);
}

/** project list row (GET /projects, /projects/{unid}) -> a render-friendly search hit. */
function projectRowToHit(p) {
  return {
    provenance: "index",
    unid: p.unid,
    txHash: p.live_tx_hash,
    index: p.live_index ?? 0,
    title: p.title,
    source: p.source_url,
    created: p.created_at,
    active: p.active,
    address: p.ckb_address,
    project_sha256: null,
    merkle_root: null,
    hashes: [],
    files: null,
    count: null,
  };
}

/** GET /versions/{txHash} -> a search hit, for direct tx-hash lookups. */
function versionToHit(v) {
  return {
    provenance: "index",
    unid: v.unid,
    txHash: v.tx_hash,
    index: 0,
    title: v.manifest?.title ?? "(untitled)",
    source: v.manifest?.source ?? null,
    created: v.manifest?.created ?? null,
    active: v.live === true,
    address: v.owner_address,
    project_sha256: v.project_sha256,
    merkle_root: v.merkle_root,
    hashes: (v.manifest?.files ?? []).map((f) => f.h),
    files: v.manifest?.files ?? null,
    count: v.manifest?.count ?? (v.manifest?.files ?? []).length,
  };
}

/** Query the global index for a search string. Never throws — signals `apiDown` instead. */
async function apiSearch(network, q) {
  try {
    if (looksLikeHex64(q)) {
      const hex = q.replace(/^0x/, "").toLowerCase();
      const byHash = await apiSearchProjects(network, { hash: hex, limit: 20 });
      if (byHash?.data?.length) return { hits: byHash.data.map(projectRowToHit), apiDown: false };

      const txHash = q.startsWith("0x") ? q : `0x${q}`;
      const version = await apiGetVersion(network, txHash);
      return { hits: version ? [versionToHit(version)] : [], apiDown: false };
    }
    if (looksLikeAddress(q)) {
      const byAddr = await apiSearchProjects(network, { address: q, limit: 20 });
      return { hits: (byAddr?.data ?? []).map(projectRowToHit), apiDown: false };
    }
    const byTitle = await apiSearchProjects(network, { q, limit: 20 });
    return { hits: (byTitle?.data ?? []).map(projectRowToHit), apiDown: false };
  } catch (e) {
    console.warn("global index unavailable, showing local results only", e);
    return { hits: [], apiDown: true };
  }
}

/** API hits take priority; a local hit already represented by an API hit (same tx) is dropped. */
function mergeHits(apiHits, localHits) {
  const seen = new Set(apiHits.map((h) => h.txHash).filter(Boolean));
  return [...apiHits, ...localHits.filter((h) => !h.txHash || !seen.has(h.txHash))];
}

/* ================================================================== */
/* Runtime network (phase 10b) — resolved/persisted the same way on   */
/* every page: build-time default from `core`'s NETWORK, overridden by */
/* localStorage once the user switches the top-bar badge.             */
/* ================================================================== */
export const NETWORK_STORAGE_KEY = "vericell:network";

export function resolveInitialNetwork() {
  try {
    const stored = localStorage.getItem(NETWORK_STORAGE_KEY);
    if (stored === "testnet" || stored === "mainnet") return stored;
  } catch {
    /* localStorage unavailable (private mode, etc.) — fall back to the build default */
  }
  return NETWORK;
}

export function makeChainClient(network) {
  if (network === "mainnet") return new ccc.ClientPublicMainnet();
  if (network === "devnet") {
    return new ccc.ClientPublicTestnet({
      url: import.meta.env.VITE_DEVNET_RPC_URL || "http://127.0.0.1:28114",
    });
  }
  return new ccc.ClientPublicTestnet();
}

export function explorerTxUrl(network, txHash) {
  return `${explorerUrlForNetwork(network)}/transaction/${txHash}`;
}

export function renderNetworkBadge(network) {
  const el = document.getElementById("networkBadge");
  if (!el) return;
  el.textContent = network.toUpperCase();
  el.className = "net-badge"; // reset the previous network's modifier class
  el.classList.add(`net-badge--${network}`);
  el.title =
    network === "mainnet"
      ? "Mainnet — anchoring costs real CKB. Click to switch."
      : `${network} — for testing only. Click to switch.`;
}

/** Wires the top-bar network-badge popover. `getNetwork()` reads the caller's current
 *  network; `onSwitch(target)` performs whatever page-specific work a switch requires
 *  (main.js also resets the wallet; verify.js just re-runs the current view). */
export function wireNetworkSwitch(getNetwork, onSwitch) {
  const badge = document.getElementById("networkBadge");
  const box = document.getElementById("netConfirm");
  const text = document.getElementById("netConfirmText");
  const yes = document.getElementById("netConfirmYes");
  const no = document.getElementById("netConfirmNo");
  if (!badge || !box || !text || !yes || !no) return;

  function closePopover() {
    box.hidden = true;
    badge.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutsideClick);
  }
  function onOutsideClick(e) {
    if (!box.contains(e.target) && e.target !== badge) closePopover();
  }

  badge.onclick = (e) => {
    e.stopPropagation();
    if (!box.hidden) {
      closePopover();
      return;
    }
    const target = getNetwork() === "mainnet" ? "testnet" : "mainnet";
    text.textContent =
      target === "mainnet"
        ? "Switch to Mainnet — anchoring uses real CKB."
        : "Switch to Testnet — for testing only, uses test CKB with no real value.";
    yes.textContent = `Switch to ${target === "mainnet" ? "Mainnet" : "Testnet"}`;
    yes.onclick = () => {
      closePopover();
      onSwitch(target);
    };
    no.onclick = closePopover;
    box.hidden = false;
    badge.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onOutsideClick);
  };
}

/** The topnav "API" link — points straight at the interactive docs (one Swagger UI, not network-scoped). */
export function wireApiNavLink() {
  const link = document.getElementById("apiNavLink");
  if (!link) return;
  const base = API_BASE || "https://api.vericell.example";
  link.href = `${base}/api/v1/docs`;
}

export function wireDropzone(el, onFiles) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("is-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("is-over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("is-over");
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  });
  el.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = () => input.files.length && onFiles(input.files);
    input.click();
  });
}

/* ================================================================== */
/* Local registry (browser index of created proofs).                  */
/* Offline/no-API fallback and instant "this device" results — the     */
/* API's index is authoritative when reachable. Shared across pages    */
/* (same origin, same localStorage) so /verify sees proofs this device */
/* created via the main page too.                                     */
/* ================================================================== */
function regKey(network) {
  return `vericell:${network}`;
}
export function loadRegistry(network) {
  try {
    return JSON.parse(localStorage.getItem(regKey(network)) || "[]");
  } catch {
    return [];
  }
}
export function saveRegistry(network, list) {
  localStorage.setItem(regKey(network), JSON.stringify(list));
}
export function addToRegistry(network, rec) {
  const list = loadRegistry(network);
  list.unshift(rec);
  saveRegistry(network, list);
}
function searchRegistry(network, q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  return loadRegistry(network).filter(
    (r) =>
      r.title.toLowerCase().includes(q) ||
      r.txHash.toLowerCase().includes(q.replace(/^0x/, "")) ||
      (r.address && r.address.toLowerCase() === q) ||
      r.project_sha256 === q ||
      (r.merkle_root && r.merkle_root === q) ||
      r.hashes.includes(q),
  );
}

/** Fetch a proof cell from chain: live status, data, block time. Exported for
 *  certificate.js (phase 4), which needs the same chain lookup to fill in a
 *  certificate's manifest/owner/block-time fields for an arbitrary version. */
export async function fetchProofFromChain(client, txHash, index = 0) {
  const out = { live: null, manifest: null, blockTime: null, lockOwner: null };
  try {
    const res = await client.getTransaction(txHash);
    if (!res) return out;
    const txOut = res.transaction?.outputs?.[index];
    const rawData = res.transaction?.outputsData?.[index];
    if (rawData) {
      try {
        out.manifest = JSON.parse(new TextDecoder().decode(ccc.bytesFrom(rawData)));
      } catch {
        /* not a VeriCell manifest */
      }
    }
    if (txOut?.lock) {
      out.lockOwner = ccc.Address.fromScript(txOut.lock, client).toString();
    }
    if (res.blockHash) {
      try {
        const header = await client.getHeaderByHash(res.blockHash);
        if (header?.timestamp) out.blockTime = new Date(Number(header.timestamp));
      } catch {
        /* header lookup optional */
      }
    }
    try {
      const cell = await client.getCellLive({ txHash, index: ccc.numFrom(index) }, false);
      out.live = !!cell;
    } catch {
      out.live = false;
    }
  } catch (e) {
    console.warn("chain lookup failed", e);
  }
  return out;
}

/** Signature element: SHA-256 rendered as 16 colored bars. */
export function fpStrip(hex, el) {
  if (!hex || !el) return;
  el.innerHTML = "";
  for (let i = 0; i < 32; i += 2) {
    const span = document.createElement("span");
    const hue = parseInt(hex.substr(i * 2, 3), 16) % 360;
    const light = 35 + (parseInt(hex.substr(i * 2 + 3, 1), 16) % 30);
    span.style.background = `hsl(${hue} 55% ${light}%)`;
    el.appendChild(span);
  }
}

/** Exported for certificate.js (phase 4), which renders the same file paths
 *  into a static HTML document and needs the identical escaping. */
export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Small visual chain: ● live, ⊗ consumed, ○ pending — a compact companion to the tx-linked timeline. */
function renderCellDiagram(nodes) {
  const glyph = { live: "●", consumed: "⊗", pending: "○" };
  return `<div class="cell-diagram">${nodes
    .map(
      (n, i) =>
        `${i > 0 ? '<span class="cell-link">→</span>' : ""}<span class="cell-node ${n.status}" title="${escapeHtml(n.label)}">${glyph[n.status]}</span>`,
    )
    .join("")}</div>`;
}

/** The canonical, shareable, bookmarkable status URL for a project (phase 3's `/status/unid/...`). */
export function canonicalStatusUrl(unid) {
  return `${location.origin}/status/unid/${encodeURIComponent(unid)}`;
}

/** Copies `text` to the clipboard and briefly flashes `btn`'s label as feedback, if given. */
export async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = "Copied ✔";
      setTimeout(() => (btn.textContent = original), 1500);
    }
  } catch {
    /* clipboard API unavailable — nothing to fall back to here, the caller's own UI still shows the value */
  }
}

/** Renders search hits into `targetId` (defaults to #searchResults, the global search/verify
 *  results box; main.js's "Your projects" list (phase 5) passes its own container id so the
 *  two lists don't clobber each other). `onSelect(rec)` is called when a card is activated
 *  (click or Enter/Space — a plain `<div>`, not `<a>`, since the verify page's cards also
 *  carry a nested "copy link" button and interactive content can't nest in `<a>`).
 *  `showCanonicalLink` adds each card's shareable `/status/unid/...` URL (verify page and the
 *  "Your projects" list). `emptyMessage`/`apiDownMessage` let a caller with a different empty
 *  state (e.g. "No projects yet — anchor your first one above.") reuse this renderer instead
 *  of forking it. */
export function renderResults(
  records,
  {
    apiDown = false,
    matchedHash = null,
    network,
    client,
    onSelect,
    showCanonicalLink = false,
    targetId = "searchResults",
    emptyMessage = "No matches. Paste a transaction hash to look a proof up directly on-chain.",
    apiDownMessage = "Global index unavailable right now — showing results from this device only.",
  } = {},
) {
  const box = document.getElementById(targetId);
  box.innerHTML = "";
  if (apiDown) {
    const note = document.createElement("p");
    note.className = "gate-note";
    note.textContent = apiDownMessage;
    box.appendChild(note);
  }
  if (!records.length) {
    const p = document.createElement("p");
    p.className = "gate-note";
    p.textContent = emptyMessage;
    box.appendChild(p);
    return;
  }
  for (const r of records) {
    const card = document.createElement("div");
    card.className = "result-card";
    card.setAttribute("role", "link");
    card.tabIndex = 0;
    card.innerHTML = `
      <span class="rc-title"></span>
      <span class="badge provenance ${r.provenance === "index" ? "idx" : "dev"}">${
        r.provenance === "index" ? "global index" : "this device"
      }</span>
      ${
        r.provenance === "index"
          ? `<span class="badge status ${r.active ? "live" : "dead"}">${r.active ? "LIVE" : "consumed"}</span>`
          : '<span class="badge status live">checking…</span>'
      }
      ${matchedHash ? '<span class="badge match">hash match</span>' : ""}
      <div class="fp-strip small"></div>
      <div class="rc-meta"></div>
      ${
        showCanonicalLink && r.unid
          ? `<div class="submit-row">
               <code class="hash-code">${escapeHtml(canonicalStatusUrl(r.unid))}</code>
               <button class="btn btn-ghost btn-small" type="button" data-copy-canonical>
                 Copy link
               </button>
             </div>`
          : ""
      }`;
    card.querySelector(".rc-title").textContent = r.title || "(untitled)";
    card.querySelector(".rc-meta").textContent =
      `${r.count ?? "?"} entries · ${r.created ? new Date(r.created).toLocaleString() : "—"} · tx ${
        r.txHash ? r.txHash.slice(0, 14) + "…" : "—"
      }`;
    fpStrip(r.project_sha256, card.querySelector(".fp-strip"));

    const activate = () => onSelect?.(r);
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-copy-canonical]")) return;
      activate();
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
    const copyBtn = card.querySelector("[data-copy-canonical]");
    if (copyBtn) {
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        copyText(canonicalStatusUrl(r.unid), copyBtn);
      };
    }
    box.appendChild(card);

    if (r.provenance === "index" && !r.project_sha256 && r.unid) {
      // list rows don't carry a hash — fill the fingerprint strip in lazily.
      apiGetProject(network, r.unid)
        .then((detail) =>
          fpStrip(detail?.live_version?.project_sha256, card.querySelector(".fp-strip")),
        )
        .catch(() => {});
    }
    if (r.provenance === "device" && r.txHash) {
      fetchProofFromChain(client, r.txHash, r.index).then(({ live }) => {
        const badgeEl = card.querySelector(".badge.status");
        if (!badgeEl) return;
        if (live === true) badgeEl.textContent = "LIVE";
        else if (live === false) {
          badgeEl.textContent = "consumed";
          badgeEl.className = "badge status dead";
        } else badgeEl.textContent = "unknown";
      });
    }
  }
}

/** Full search: the local (this-device) registry plus the global index, merged and rendered. */
export async function runSearch(network, client, q, opts = {}) {
  const localHits = searchRegistry(network, q).map((r) => ({ ...r, provenance: "device" }));
  const { hits: apiHits, apiDown } = q ? await apiSearch(network, q) : { hits: [], apiDown: false };
  renderResults(mergeHits(apiHits, localHits), { ...opts, apiDown, network, client });
}

/** Every project (live or consumed) anchored by `address` — the connected wallet's "Your
 *  projects" list (phase 5). Same shape/fallback as `runSearch`: local registry entries for
 *  this address are merged with the global index so a just-anchored/updated/withdrawn project
 *  shows up immediately, even before the index has caught up; if the API is unreachable, the
 *  local entries alone still render (with the same `apiDown` note `runSearch` shows). */
export async function fetchOwnerProjects(network, address) {
  const localHits = loadRegistry(network)
    .filter((r) => r.address === address)
    .map((r) => ({ ...r, provenance: "device" }));
  try {
    const byAddr = await apiSearchProjects(network, { address, limit: 100 });
    const apiHits = (byAddr?.data ?? []).map(projectRowToHit);
    return { hits: mergeHits(apiHits, localHits), apiDown: false };
  } catch (e) {
    console.warn("global index unavailable, showing local results only", e);
    return { hits: localHits, apiDown: true };
  }
}

/** Rendered from GET /projects/{unid}: full version chain, live/consumed from the index.
 *  `buildActionsHtml(ctx)`/`wireActions(panel, ctx)` let the caller add page-specific actions
 *  (main.js's owner-only new-version/withdraw buttons, or verify.js's canonical-link/copy) —
 *  `ctx` is `{ active, txHash, index, title, sourceUrl, versionNo, ownerAddress, unid }`.
 *  `buildVersionActionsHtml(vctx)`/`wireVersionActions(panel, vctxList)` (phase 4) do the same
 *  for a small per-row action pair on *every* version in the timeline below, live or consumed —
 *  both pages pass the same certificate.js functions here, since regenerating a certificate
 *  isn't an owner-only action. */
async function renderDetailFromApi(
  detail,
  rec,
  { network, client, buildActionsHtml, wireActions, buildVersionActionsHtml, wireVersionActions },
) {
  const panel = document.getElementById("detailPanel");
  const live = detail.live_version;

  let manifest = null;
  if (live) {
    try {
      manifest = (await apiGetVersion(network, live.tx_hash))?.manifest ?? null;
    } catch {
      /* best-effort — the timeline below doesn't depend on this */
    }
  }
  const files = manifest?.files || rec.files || [];
  const ctx = {
    active: detail.active,
    txHash: detail.live_tx_hash,
    index: detail.live_index ?? 0,
    title: detail.title,
    sourceUrl: detail.source_url,
    versionNo: live?.version_no,
    ownerAddress: detail.ckb_address,
    unid: detail.unid,
  };

  /** One certificate.js `vctx` per version in the chain — live, consumed, or pending. */
  const versionsCtx = detail.versions.map((v) => {
    const successorRow = detail.versions.find((w) => w.prev_tx_hash === v.tx_hash) ?? null;
    return {
      client,
      network,
      unid: detail.unid,
      txHash: v.tx_hash,
      index: 0,
      versionNo: v.version_no,
      active: v.tx_hash === detail.live_tx_hash ? true : v.status === "pending" ? null : false,
      successor: successorRow
        ? { unid: detail.unid, txHash: successorRow.tx_hash, versionNo: successorRow.version_no }
        : null,
      title: detail.title,
      sourceUrl: detail.source_url,
      knownManifest: v.tx_hash === detail.live_tx_hash ? manifest : null,
    };
  });

  panel.innerHTML = `
    <h3></h3>
    <div class="fp-strip"></div>
    <dl class="kv">
      <dt>Status</dt><dd>${
        detail.active
          ? '<span class="badge live">LIVE — current version</span>'
          : '<span class="badge dead">withdrawn — no live version</span>'
      }</dd>
      <dt>Project ID (UNID)</dt><dd>${detail.unid}</dd>
      <dt>Overall SHA-256</dt><dd>${live?.project_sha256 ?? "—"}</dd>
      <dt>Merkle root</dt><dd>${live?.merkle_root ?? "—"}</dd>
      <dt>Created</dt><dd>${new Date(detail.created_at).toISOString()}</dd>
      <dt>Owner (lock)</dt><dd>${detail.ckb_address}</dd>
      <dt>Source URL</dt><dd>${
        detail.source_url
          ? `<a href="${detail.source_url}" target="_blank" rel="noopener">${detail.source_url}</a>`
          : "—"
      }</dd>
    </dl>
    <p><strong>Version chain</strong> — consumed ⊗ / live ●:</p>
    ${renderCellDiagram(
      detail.versions.map((v) => ({
        status:
          v.tx_hash === detail.live_tx_hash
            ? "live"
            : v.status === "pending"
              ? "pending"
              : "consumed",
        label: `v${v.version_no ?? "?"} · ${v.status} · ${v.tx_hash}`,
      })),
    )}
    <ol class="version-timeline">
      ${detail.versions
        .map(
          (v, i) => `
        <li class="${v.tx_hash === detail.live_tx_hash ? "is-live" : ""}">
          <span class="vt-no">v${v.version_no ?? "?"}</span>
          <span class="badge ${v.status === "consumed" ? "dead" : v.status === "pending" ? "pending" : "live"}">${v.status}</span>
          <a class="vt-tx" href="${explorerTxUrl(network, v.tx_hash)}" target="_blank" rel="noopener">${v.tx_hash.slice(0, 18)}…</a>
          <span class="vt-time">${v.block_time ? new Date(v.block_time).toLocaleString() : "pending"}</span>
          ${buildVersionActionsHtml ? buildVersionActionsHtml(versionsCtx[i]) : ""}
        </li>`,
        )
        .join("")}
    </ol>
    ${
      files.length
        ? `<p><strong>${files.length}</strong> fingerprinted entries:</p>
      <ul class="file-list">${files
        .map(
          (f) =>
            `<li><span class="fpath">${escapeHtml(f.p)}</span><span class="fhash">${f.h}</span><span></span></li>`,
        )
        .join("")}</ul>`
        : `<p class="gate-note">Compact proof — individual file hashes are represented by the Merkle root.</p>`
    }
    <div class="submit-row">
      ${buildActionsHtml ? buildActionsHtml(ctx) : ""}
      <span id="detailStatus" class="status"></span>
      <span class="gate-note">Source: global index${API_BASE ? ` (${API_BASE})` : ""}</span>
    </div>`;
  panel.querySelector("h3").textContent = detail.title;
  fpStrip(live?.project_sha256, panel.querySelector(".fp-strip"));
  wireActions?.(panel, ctx);
  wireVersionActions?.(panel, versionsCtx);
}

/** Fallback when the global index is unreachable or doesn't (yet) have this project:
 *  the single version the caller clicked into, read straight from the chain. */
async function renderDetailFromChain(
  rec,
  { network, client, buildActionsHtml, wireActions, buildVersionActionsHtml, wireVersionActions },
) {
  const panel = document.getElementById("detailPanel");
  const chain = await fetchProofFromChain(client, rec.txHash, rec.index);
  const m = chain.manifest || rec;
  const files = m.files || rec.files || [];
  const ownerAddress = chain.lockOwner || rec.address || null;
  const ctx = {
    active: chain.live !== false,
    txHash: rec.txHash,
    index: rec.index,
    title: rec.title,
    sourceUrl: rec.source,
    ownerAddress,
    unid: rec.unid,
  };
  /* No global index here, so no version chain either — a single certificate.js
   * `vctx` for the one version this chain lookup resolved (phase 4). */
  const versionCtx = {
    client,
    network,
    unid: rec.unid,
    txHash: rec.txHash,
    index: rec.index,
    versionNo: null,
    active: chain.live,
    successor: null,
    title: ctx.title,
    sourceUrl: ctx.sourceUrl,
    knownManifest: chain.manifest || null,
  };

  panel.innerHTML = `
    <h3></h3>
    <div class="fp-strip"></div>
    <dl class="kv">
      <dt>Status</dt><dd>${
        chain.live === true
          ? '<span class="badge live">LIVE — current version</span>'
          : chain.live === false
            ? '<span class="badge dead">consumed — superseded or withdrawn</span>'
            : "unknown"
      }</dd>
      <dt>Project ID (UNID)</dt><dd>${rec.unid}</dd>
      <dt>Overall SHA-256</dt><dd>${m.project_sha256 || rec.project_sha256}</dd>
      <dt>Merkle root</dt><dd>${m.merkle_root || rec.merkle_root || "—"}</dd>
      <dt>Created (manifest)</dt><dd>${m.created || rec.created}</dd>
      <dt>Block timestamp</dt><dd>${chain.blockTime ? chain.blockTime.toISOString() + " (authoritative)" : "pending / unavailable"}</dd>
      <dt>Owner (lock)</dt><dd>${ownerAddress || "—"}</dd>
      <dt>Source URL</dt><dd>${m.source ? `<a href="${m.source}" target="_blank" rel="noopener">${m.source}</a>` : "—"}</dd>
      <dt>Transaction</dt><dd><a href="${explorerTxUrl(network, rec.txHash)}" target="_blank" rel="noopener">${rec.txHash}</a></dd>
    </dl>
    <p><strong>Version chain</strong> — consumed ⊗ / live ●:</p>
    ${renderCellDiagram([
      {
        status: chain.live === true ? "live" : chain.live === false ? "consumed" : "pending",
        label: `${rec.txHash} · ${chain.live === true ? "live" : chain.live === false ? "consumed" : "unknown"}`,
      },
    ])}
    ${
      files.length
        ? `<p><strong>${files.length}</strong> fingerprinted entries:</p>
      <ul class="file-list">${files
        .map(
          (f) =>
            `<li><span class="fpath">${escapeHtml(f.p)}</span><span class="fhash">${f.h}</span><span></span></li>`,
        )
        .join("")}</ul>`
        : `<p class="gate-note">Compact proof — individual file hashes are represented by the Merkle root.</p>`
    }
    <div class="submit-row">
      ${buildActionsHtml ? buildActionsHtml(ctx) : ""}
      ${buildVersionActionsHtml ? buildVersionActionsHtml(versionCtx) : ""}
      <span id="detailStatus" class="status"></span>
      <span class="gate-note">${API_BASE ? "Global index unavailable — direct chain lookup." : "Not connected to a global index — direct chain lookup."}</span>
    </div>`;
  panel.querySelector("h3").textContent = m.title || rec.title;
  fpStrip(m.project_sha256 || rec.project_sha256, panel.querySelector(".fp-strip"));
  wireActions?.(panel, ctx);
  wireVersionActions?.(panel, [versionCtx]);
}

/** Project detail: the global index (version timeline, live/consumed from the API) when
 *  reachable; a direct on-chain lookup of just this one version otherwise. `rec` needs at
 *  least `.unid`; `.txHash`/`.index` too if the chain-only fallback should be reachable.
 *  `buildVersionActionsHtml`/`wireVersionActions` (phase 4, from certificate.js) are identical
 *  on both pages — regenerating a certificate isn't an owner-only action like `buildActionsHtml`. */
export async function showProjectDetail({
  rec,
  network,
  client,
  buildActionsHtml,
  wireActions,
  buildVersionActionsHtml,
  wireVersionActions,
}) {
  const sec = document.getElementById("detail");
  const panel = document.getElementById("detailPanel");
  sec.hidden = false;
  panel.innerHTML = `<p class="gate-note">Loading proof…</p>`;
  sec.scrollIntoView({ behavior: "smooth" });

  let detail = null;
  try {
    detail = rec.unid ? await apiGetProject(network, rec.unid) : null;
  } catch (e) {
    console.warn("project detail via the global index failed; falling back to chain-only view", e);
  }

  const opts = {
    network,
    client,
    buildActionsHtml,
    wireActions,
    buildVersionActionsHtml,
    wireVersionActions,
  };
  if (detail) await renderDetailFromApi(detail, rec, opts);
  else await renderDetailFromChain(rec, opts);
}
