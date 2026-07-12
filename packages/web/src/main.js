/**
 * VeriCell — proof of authorship, integrity and time on Nervos CKB.
 *
 * All hashing happens locally (Web Crypto, SHA-256). Only the manifest
 * (title, paths, hashes, source URL) is written into the data field of a
 * live CKB cell locked to the user's wallet.
 *
 * Wallet + chain access via CCC: https://github.com/ckb-devrel/ccc
 * Hashing/Merkle/manifest logic and the network flag are shared with the
 * rest of the stack via `core` (packages/core) — no duplicated crypto here.
 */
import { ccc } from "@ckb-ccc/ccc";
import {
  sha256Hex,
  projectHash as coreProjectHash,
  merkleRoot as coreMerkleRoot,
  encodeManifest,
  estimateCellCost,
  NETWORK,
  explorerUrlForNetwork,
} from "core";

/* ================================================================== */
/* API client — global index, with localStorage as offline fallback   */
/*                                                                     */
/* The network is runtime state (phase 10b) — every API call is       */
/* scoped under /api/v1/{network}/... (see packages/api build.ts's    */
/* per-network mounts), re-derived from `state.network` on each call  */
/* so a network switch takes effect immediately, no page reload.      */
/* ================================================================== */
const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

function apiUrlBase() {
  return `${API_BASE}/api/v1/${state.network}`;
}

async function apiFetch(path) {
  if (!API_BASE) throw new Error("no API configured (VITE_API_URL unset)");
  const res = await fetch(`${apiUrlBase()}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  return res.json();
}

function apiSearchProjects(params) {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/projects?${qs}`);
}
function apiGetProject(unid) {
  return apiFetch(`/projects/${encodeURIComponent(unid)}`);
}
function apiGetVersion(txHash) {
  return apiFetch(`/versions/${txHash}`);
}

function looksLikeHex64(q) {
  return /^(0x)?[a-fA-F0-9]{64}$/.test(q);
}
function looksLikeAddress(q) {
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
async function apiSearch(q) {
  try {
    if (looksLikeHex64(q)) {
      const hex = q.replace(/^0x/, "").toLowerCase();
      const byHash = await apiSearchProjects({ hash: hex, limit: 20 });
      if (byHash?.data?.length) return { hits: byHash.data.map(projectRowToHit), apiDown: false };

      const txHash = q.startsWith("0x") ? q : `0x${q}`;
      const version = await apiGetVersion(txHash);
      return { hits: version ? [versionToHit(version)] : [], apiDown: false };
    }
    if (looksLikeAddress(q)) {
      const byAddr = await apiSearchProjects({ address: q, limit: 20 });
      return { hits: (byAddr?.data ?? []).map(projectRowToHit), apiDown: false };
    }
    const byTitle = await apiSearchProjects({ q, limit: 20 });
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
/* State                                                              */
/*                                                                     */
/* `state.network` is runtime state (phase 10b), not a build-time     */
/* constant: it defaults to `core`'s NETWORK (VITE_VERICELL_NETWORK   */
/* at build time — mainnet in a production build, testnet in dev),    */
/* but a user switching the top-bar badge overrides it and the        */
/* override is persisted in localStorage so it survives reloads.      */
/* Only testnet/mainnet are reachable from the badge; a devnet build  */
/* (local offckb testing) is unaffected — see wireNetworkSwitch().    */
/* ================================================================== */
const NETWORK_STORAGE_KEY = "vericell:network";

function resolveInitialNetwork() {
  try {
    const stored = localStorage.getItem(NETWORK_STORAGE_KEY);
    if (stored === "testnet" || stored === "mainnet") return stored;
  } catch {
    /* localStorage unavailable (private mode, etc.) — fall back to the build default */
  }
  return NETWORK;
}

function makeChainClient(network) {
  if (network === "mainnet") return new ccc.ClientPublicMainnet();
  if (network === "devnet") {
    return new ccc.ClientPublicTestnet({
      url: import.meta.env.VITE_DEVNET_RPC_URL || "http://127.0.0.1:28114",
    });
  }
  return new ccc.ClientPublicTestnet();
}

const state = {
  network: resolveInitialNetwork(),
  client: null, // set below, once state.network is known
  signer: null,
  address: null,
  entries: [], // [{ p: path, h: sha256hex, bytes }]
  pendingPrev: null, // set while the create panel is in "publish new version" mode
};
state.client = makeChainClient(state.network);

const MANIFEST_APP = "vericell";
const MANIFEST_VERSION = 1;

/* ================================================================== */
/* Hashing / manifest helpers — core does the actual crypto           */
/* ================================================================== */
/** core's FileEntry shape is { path, hash }; the UI works in { p, h }. */
function toFileEntries(entries) {
  return entries.map((e) => ({ path: e.p, hash: e.h }));
}
async function projectHash(entries) {
  return coreProjectHash(toFileEntries(entries));
}
async function merkleRoot(entries) {
  return coreMerkleRoot(toFileEntries(entries));
}

/* ================================================================== */
/* Local registry (browser index of created proofs).                  */
/* Offline/no-API fallback and instant "this device" results — the     */
/* API's index is authoritative when reachable.                       */
/* ================================================================== */
function regKey() {
  return `vericell:${state.network}`;
}
function loadRegistry() {
  try {
    return JSON.parse(localStorage.getItem(regKey()) || "[]");
  } catch {
    return [];
  }
}
function saveRegistry(list) {
  localStorage.setItem(regKey(), JSON.stringify(list));
}
function addToRegistry(rec) {
  const list = loadRegistry();
  list.unshift(rec);
  saveRegistry(list);
}

/* ================================================================== */
/* Wallet (JoyID via CCC — other CCC signers plug in the same way)    */
/* ================================================================== */
async function connectWallet() {
  const btn = document.getElementById("connectBtn");
  try {
    btn.textContent = "Connecting…";
    state.signer = new ccc.JoyId.CkbSigner(state.client, "VeriCell", location.origin + "/icon.svg");
    await state.signer.connect();
    state.address = await state.signer.getRecommendedAddress();
    btn.textContent = `${state.address.slice(0, 8)}…${state.address.slice(-6)}`;
    btn.classList.add("is-connected");
    btn.title = state.address;
    document.getElementById("createPanel").classList.remove("is-locked");
    document.getElementById("createGate").textContent = "Wallet connected — you can anchor proofs.";
  } catch (e) {
    btn.textContent = "Connect wallet";
    setStatus("submitStatus", `Wallet connection failed: ${e.message || e}`, true);
  }
}

/* ================================================================== */
/* Manifest & on-chain anchoring                                      */
/* ================================================================== */
function buildManifest({ compact, title, url, projHash, root, prev, genesis }) {
  const m = {
    app: MANIFEST_APP,
    v: MANIFEST_VERSION,
    title,
    created: new Date().toISOString(),
    project_sha256: projHash,
    merkle_root: root,
    count: state.entries.length,
  };
  if (url) m.source = url;
  if (prev) m.prev = prev; // tx hash of previous version's cell
  if (genesis) m.genesis = genesis; // tx hash of the very first version (project UNID)
  if (!compact) m.files = state.entries.map((e) => ({ p: e.p, h: e.h }));
  return m;
}

/** Create the proof cell. Optionally consumes the previous version's cell
 *  (`genesis`/`prevTxHash` then bind the new manifest into that version chain). */
async function anchorProof({ compact, prevOutPoint, genesis, prevTxHash }) {
  if (!state.signer) throw new Error("Connect a wallet first.");
  if (state.entries.length === 0) throw new Error("Add at least one file or hash.");

  const title = document.getElementById("projTitle").value.trim() || "Untitled project";
  const url = document.getElementById("projUrl").value.trim();
  const projHash = await projectHash(state.entries);
  const root = await merkleRoot(state.entries);

  const manifest = buildManifest({
    compact,
    title,
    url,
    projHash,
    root,
    prev: prevTxHash,
    genesis,
  });
  const data = encodeManifest(manifest);

  const { script: lock } = await state.signer.getRecommendedAddressObj();

  const tx = ccc.Transaction.from({
    inputs: prevOutPoint ? [{ previousOutput: prevOutPoint }] : [],
    outputs: [{ lock }], // capacity auto-set to the minimum for the data
    outputsData: [data],
  });
  await tx.completeInputsByCapacity(state.signer);
  await tx.completeFeeBy(state.signer, 1000);
  const txHash = await state.signer.sendTransaction(tx);

  addToRegistry({
    unid: txHash, // v1: creation tx hash. Production: type ID (TECHNICAL.md)
    txHash,
    index: 0,
    title,
    source: url || null,
    created: manifest.created,
    active: true,
    address: state.address,
    project_sha256: projHash,
    merkle_root: root,
    hashes: state.entries.map((e) => e.h), // backward search: every file hash
    files: manifest.files || null,
    count: state.entries.length,
    network: state.network,
  });
  return { txHash, manifest };
}

/* ================================================================== */
/* Search & on-chain verification                                     */
/* ================================================================== */
function searchRegistry(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  return loadRegistry().filter(
    (r) =>
      r.title.toLowerCase().includes(q) ||
      r.txHash.toLowerCase().includes(q.replace(/^0x/, "")) ||
      (r.address && r.address.toLowerCase() === q) ||
      r.project_sha256 === q ||
      (r.merkle_root && r.merkle_root === q) ||
      r.hashes.includes(q),
  );
}

/** Fetch a proof cell from chain: live status, data, block time. */
async function fetchProofFromChain(txHash, index = 0) {
  const out = { live: null, manifest: null, blockTime: null, lockOwner: null };
  try {
    const res = await state.client.getTransaction(txHash);
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
      out.lockOwner = ccc.Address.fromScript(txOut.lock, state.client).toString();
    }
    if (res.blockHash) {
      try {
        const header = await state.client.getHeaderByHash(res.blockHash);
        if (header?.timestamp) out.blockTime = new Date(Number(header.timestamp));
      } catch {
        /* header lookup optional */
      }
    }
    try {
      const cell = await state.client.getCellLive({ txHash, index: ccc.numFrom(index) }, false);
      out.live = !!cell;
    } catch {
      out.live = false;
    }
  } catch (e) {
    console.warn("chain lookup failed", e);
  }
  return out;
}

/* ================================================================== */
/* Input sources                                                      */
/* ================================================================== */
async function addFiles(fileList) {
  const files = [...fileList];
  setStatus("submitStatus", `Hashing ${files.length} file(s)…`);
  for (const f of files) {
    const path = f.webkitRelativePath || f.name;
    const h = await sha256Hex(await f.arrayBuffer());
    upsertEntry({ p: path, h, bytes: f.size });
  }
  setStatus("submitStatus", "");
  renderManifest();
}

async function addGithubRepo(spec) {
  let [repo, branch] = spec
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .split("@");
  repo = repo.replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error("Use the form owner/repo or owner/repo@branch");
  if (!branch) {
    const meta = await (await fetch(`https://api.github.com/repos/${repo}`)).json();
    branch = meta.default_branch || "main";
  }
  const tree = await (
    await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`)
  ).json();
  if (!tree.tree) throw new Error(tree.message || "Could not read the repository tree.");
  const blobs = tree.tree.filter((t) => t.type === "blob").slice(0, 200);
  let done = 0;
  for (const b of blobs) {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${b.path}`);
    if (!res.ok) continue;
    const h = await sha256Hex(await res.arrayBuffer());
    upsertEntry({ p: b.path, h, bytes: b.size ?? 0 });
    setStatus("submitStatus", `Hashing ${repo}@${branch}: ${++done}/${blobs.length}`);
  }
  setStatus("submitStatus", "");
  renderManifest();
}

async function addUrl(url) {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      `Fetch failed (${res.status}). The server may block CORS — download the file and use "Local files".`,
    );
  const buf = await res.arrayBuffer();
  const h = await sha256Hex(buf);
  upsertEntry({ p: url, h, bytes: buf.byteLength });
  renderManifest();
}

function addPastedHashes(text) {
  for (const line of text.split("\n")) {
    const m =
      line.trim().match(/^(.*?)[\s,;]+([a-fA-F0-9]{64})$/) ||
      line.trim().match(/^([a-fA-F0-9]{64})$/);
    if (!m) continue;
    const h = (m[2] || m[1]).toLowerCase();
    const p = m[2] ? m[1].trim() : `hash-${h.slice(0, 8)}`;
    upsertEntry({ p, h, bytes: 0 });
  }
  renderManifest();
}

function upsertEntry(entry) {
  const i = state.entries.findIndex((e) => e.p === entry.p);
  if (i >= 0) state.entries[i] = entry;
  else state.entries.push(entry);
}

/* ================================================================== */
/* UI rendering                                                       */
/* ================================================================== */
function setStatus(id, msg, err = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("err", err);
}

/** Signature element: SHA-256 rendered as 16 colored bars. */
function fpStrip(hex, el) {
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

function renderNetworkBadge() {
  const el = document.getElementById("networkBadge");
  if (!el) return;
  el.textContent = state.network.toUpperCase();
  el.className = "net-badge"; // reset the previous network's modifier class
  el.classList.add(`net-badge--${state.network}`);
  el.title =
    state.network === "mainnet"
      ? "Mainnet — anchoring costs real CKB. Click to switch."
      : `${state.network} — for testing only. Click to switch.`;
}

/** curl examples in the "API & automation" section, filled in with the actual API base and network. */
function renderApiSection() {
  const base = API_BASE || "https://api.vericell.example";
  const v1 = `${base}/api/v1/${state.network}`;
  const prepareEl = document.getElementById("curlPrepare");
  const submitEl = document.getElementById("curlSubmit");
  const verifyEl = document.getElementById("curlVerify");
  if (prepareEl) {
    prepareEl.textContent =
      `# 1. Prepare an unsigned anchoring transaction (non-custodial — you sign it, not the API)\n` +
      `curl -s -X POST ${v1}/proofs/prepare \\\n` +
      `  -H "Authorization: Bearer $VERICELL_API_KEY" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{"manifest":{"title":"my-project","files":[{"p":"README.md","h":"<sha256>"}]},"payer":{"lock":{...}}}'`;
  }
  if (submitEl) {
    submitEl.textContent =
      `# 2. Sign the returned tx locally (vericell CLI or any CCC signer), then submit it\n` +
      `curl -s -X POST ${v1}/proofs/submit \\\n` +
      `  -H "Authorization: Bearer $VERICELL_API_KEY" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{"tx": <signed-tx-json>}'`;
  }
  if (verifyEl) {
    verifyEl.textContent =
      `# Verify a file's hash — no API key needed, nothing is uploaded\n` +
      `sha256sum myfile.zip\n` +
      `curl -s ${v1}/verify/<sha256>`;
  }
  const docsLink = document.getElementById("apiDocsLink");
  if (docsLink) {
    // /api/v1/docs itself isn't network-scoped (one Swagger UI covers every mounted network).
    docsLink.href = `${base}/api/v1/docs`;
    if (!API_BASE) docsLink.textContent = "interactive API docs (set VITE_API_URL to enable)";
  }
}

/* ================================================================== */
/* Runtime network toggle (phase 10b)                                 */
/* ================================================================== */
function explorerTxUrl(txHash) {
  return `${explorerUrlForNetwork(state.network)}/transaction/${txHash}`;
}

/** Atomically move every network-scoped piece of state to `target` and re-query open views. */
async function switchNetwork(target) {
  state.network = target;
  try {
    localStorage.setItem(NETWORK_STORAGE_KEY, target);
  } catch {
    /* localStorage unavailable — the switch still works for this page load */
  }
  state.client = makeChainClient(target);

  // A signer authorized on one network isn't valid on the other — force a
  // fresh connection rather than risk signing/reading against the wrong chain.
  state.signer = null;
  state.address = null;
  exitVersionMode();
  const connectBtn = document.getElementById("connectBtn");
  connectBtn.textContent = "Connect wallet";
  connectBtn.classList.remove("is-connected");
  connectBtn.title = "";
  document.getElementById("createPanel").classList.add("is-locked");
  document.getElementById("createGate").textContent =
    `Switched to ${target.toUpperCase()} — reconnect your wallet to create proofs.`;

  renderNetworkBadge();
  renderApiSection();

  // The open detail view (if any) belongs to whichever network it was opened
  // from; there's no cross-network mapping for a single tx/unid, so close it
  // rather than show stale or wrong-chain data.
  document.getElementById("detail").hidden = true;
  document.getElementById("detailPanel").innerHTML = "";

  const q = document.getElementById("searchInput").value.trim();
  if (q) await runSearch(q);
  else document.getElementById("searchResults").innerHTML = "";
}

function wireNetworkSwitch() {
  const badge = document.getElementById("networkBadge");
  const box = document.getElementById("netConfirm");
  const text = document.getElementById("netConfirmText");
  const yes = document.getElementById("netConfirmYes");
  const no = document.getElementById("netConfirmNo");

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
    const target = state.network === "mainnet" ? "testnet" : "mainnet";
    text.textContent =
      target === "mainnet"
        ? "Switch to Mainnet — anchoring uses real CKB."
        : "Switch to Testnet — for testing only, uses test CKB with no real value.";
    yes.textContent = `Switch to ${target === "mainnet" ? "Mainnet" : "Testnet"}`;
    yes.onclick = () => {
      closePopover();
      switchNetwork(target);
    };
    no.onclick = closePopover;
    box.hidden = false;
    badge.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onOutsideClick);
  };
}

async function renderManifest() {
  const box = document.getElementById("manifestBox");
  const list = document.getElementById("fileList");
  box.hidden = state.entries.length === 0;
  document.getElementById("fileCount").textContent = state.entries.length;
  list.innerHTML = "";
  for (const e of state.entries) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="fpath"></span><span class="fhash"></span><button class="rm" title="Remove">✕</button>`;
    li.querySelector(".fpath").textContent = e.p;
    li.querySelector(".fhash").textContent = e.h.slice(0, 16) + "…";
    li.querySelector(".rm").onclick = () => {
      state.entries = state.entries.filter((x) => x !== e);
      renderManifest();
    };
    list.appendChild(li);
  }
  if (state.entries.length) {
    const ph = await projectHash(state.entries);
    document.getElementById("projHash").textContent = ph;
    fpStrip(ph, document.getElementById("projFp"));
    const manifest = buildManifest({
      compact: false,
      title: document.getElementById("projTitle").value || "Untitled project",
      url: document.getElementById("projUrl").value,
      projHash: ph,
      root: ph,
    });
    const cost = estimateCellCost(manifest);
    document.getElementById("fullCost").textContent = `≈ ${cost.full} CKB locked (refundable)`;
    document.getElementById("rootCost").textContent = `≈ ${cost.compact} CKB locked (refundable)`;
  }
}

function renderResults(records, apiDown = false, matchedHash = null) {
  const box = document.getElementById("searchResults");
  box.innerHTML = "";
  if (apiDown) {
    const note = document.createElement("p");
    note.className = "gate-note";
    note.textContent =
      "Global index unavailable right now — showing results from this device only.";
    box.appendChild(note);
  }
  if (!records.length) {
    const p = document.createElement("p");
    p.className = "gate-note";
    p.textContent = "No matches. Paste a transaction hash to look a proof up directly on-chain.";
    box.appendChild(p);
    return;
  }
  for (const r of records) {
    const a = document.createElement("a");
    a.className = "result-card";
    a.href = `#detail`;
    a.innerHTML = `
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
      <div class="rc-meta"></div>`;
    a.querySelector(".rc-title").textContent = r.title || "(untitled)";
    a.querySelector(".rc-meta").textContent =
      `${r.count ?? "?"} entries · ${r.created ? new Date(r.created).toLocaleString() : "—"} · tx ${
        r.txHash ? r.txHash.slice(0, 14) + "…" : "—"
      }`;
    fpStrip(r.project_sha256, a.querySelector(".fp-strip"));
    a.onclick = () => showDetail(r);
    box.appendChild(a);

    if (r.provenance === "index" && !r.project_sha256 && r.unid) {
      // list rows don't carry a hash — fill the fingerprint strip in lazily.
      apiGetProject(r.unid)
        .then((detail) =>
          fpStrip(detail?.live_version?.project_sha256, a.querySelector(".fp-strip")),
        )
        .catch(() => {});
    }
    if (r.provenance === "device" && r.txHash) {
      fetchProofFromChain(r.txHash, r.index).then(({ live }) => {
        const badgeEl = a.querySelector(".badge.status");
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

async function runSearch(q, { matchedHash = null } = {}) {
  const localHits = searchRegistry(q).map((r) => ({ ...r, provenance: "device" }));
  const { hits: apiHits, apiDown } = q ? await apiSearch(q) : { hits: [], apiDown: false };
  renderResults(mergeHits(apiHits, localHits), apiDown, matchedHash);
}

/** Project detail: the global index (version timeline, live/consumed from the API) when
 *  reachable; a direct on-chain lookup of just this one version otherwise. */
async function showDetail(rec) {
  const sec = document.getElementById("detail");
  const panel = document.getElementById("detailPanel");
  sec.hidden = false;
  panel.innerHTML = `<p class="gate-note">Loading proof…</p>`;
  sec.scrollIntoView({ behavior: "smooth" });

  let detail = null;
  try {
    detail = rec.unid ? await apiGetProject(rec.unid) : null;
  } catch (e) {
    console.warn("project detail via the global index failed; falling back to chain-only view", e);
  }

  if (detail) await renderDetailFromApi(detail, rec);
  else await renderDetailFromChain(rec);
}

/* ================================================================== */
/* Create-panel "publish new version" mode (phase 10b)                */
/* ================================================================== */
/** True once a wallet is connected and its address matches the project's owner. */
function isConnectedOwner(ownerAddress) {
  return !!(state.address && ownerAddress && state.address === ownerAddress);
}

function updateCreatePanelMode() {
  const prev = state.pendingPrev;
  const heading = document.getElementById("createHeading");
  const cancelBtn = document.getElementById("cancelVersionBtn");
  const banner = document.getElementById("versionBanner");
  const submitBtn = document.getElementById("submitBtn");

  if (!prev) {
    heading.textContent = "Create a project proof";
    cancelBtn.hidden = true;
    banner.hidden = true;
    submitBtn.textContent = "Anchor proof on CKB";
    return;
  }

  const title = document.getElementById("projTitle").value || "this project";
  const nextNo = typeof prev.versionNo === "number" ? prev.versionNo + 1 : null;
  heading.textContent = `New version of: ${title}`;
  cancelBtn.hidden = false;
  banner.hidden = false;
  banner.innerHTML = `
    Anchoring will <strong>consume</strong> the current live cell
    (${typeof prev.versionNo === "number" ? `v${prev.versionNo} · ` : ""}tx
    ${prev.rec.txHash.slice(0, 14)}…) and create a new live cell. The old version stays
    permanently verifiable as <strong>superseded</strong>. Locked CKB from the old cell
    returns to your wallet.`;
  submitBtn.textContent = `Consume ${typeof prev.versionNo === "number" ? `v${prev.versionNo}` : "current"} → anchor ${nextNo ? `v${nextNo}` : "next version"}`;
}

function enterVersionMode({ txHash, index, genesis, title, sourceUrl, versionNo, ownerAddress }) {
  if (!state.signer) {
    alert("Connect your wallet first.");
    return;
  }
  if (ownerAddress && !isConnectedOwner(ownerAddress)) {
    alert("Connect the wallet that owns this project to publish a new version.");
    return;
  }
  state.pendingPrev = {
    outPoint: { txHash, index: ccc.numFrom(index) },
    genesis,
    rec: { txHash },
    versionNo,
  };
  document.getElementById("projTitle").value = title;
  document.getElementById("projUrl").value = sourceUrl || "";
  updateCreatePanelMode();
  document.getElementById("create").scrollIntoView({ behavior: "smooth" });
  setStatus(
    "submitStatus",
    "New-version mode: the previous cell will be consumed when you anchor. Add the new files.",
  );
}

function exitVersionMode() {
  state.pendingPrev = null;
  updateCreatePanelMode();
}

function wireNewVersionButton(
  panel,
  { txHash, index, genesis, title, sourceUrl, versionNo, ownerAddress },
) {
  const btn = panel.querySelector("#newVersionBtn");
  if (!btn) return;
  btn.onclick = () =>
    enterVersionMode({ txHash, index, genesis, title, sourceUrl, versionNo, ownerAddress });
}

/* ================================================================== */
/* Withdraw (phase 10b) — consume the live cell without a successor   */
/* ================================================================== */
/** Build+send a withdraw tx: consumes `outPoint`, capacity refunds to the connected wallet. */
async function withdrawProof(outPoint) {
  if (!state.signer) throw new Error("Connect a wallet first.");
  const tx = ccc.Transaction.from({ inputs: [{ previousOutput: outPoint }] });
  await tx.completeFeeBy(state.signer, 1000);
  const txHash = await state.signer.sendTransaction(tx);

  const list = loadRegistry();
  const old = list.find((r) => r.txHash === outPoint.txHash);
  if (old) {
    old.active = false;
    saveRegistry(list);
  }
  return { txHash };
}

function wireWithdrawButton(panel, { txHash, index, title, ownerAddress }) {
  const btn = panel.querySelector("#withdrawBtn");
  const box = panel.querySelector("#withdrawConfirm");
  if (!btn || !box) return;
  const input = box.querySelector("#withdrawTitleInput");
  const confirmBtn = box.querySelector("#withdrawConfirmBtn");
  const cancelBtn = box.querySelector("#withdrawCancelBtn");

  btn.onclick = () => {
    if (!state.signer) {
      alert("Connect your wallet first.");
      return;
    }
    if (ownerAddress && !isConnectedOwner(ownerAddress)) {
      alert("Connect the wallet that owns this project to withdraw it.");
      return;
    }
    input.value = "";
    confirmBtn.disabled = true;
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  input.oninput = () => {
    confirmBtn.disabled = input.value !== title;
  };
  cancelBtn.onclick = () => {
    box.hidden = true;
  };
  confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    try {
      setStatus("detailStatus", "Building withdraw transaction — confirm in your wallet…");
      const { txHash: newTxHash } = await withdrawProof({
        txHash,
        index: ccc.numFrom(index),
      });
      setStatus(
        "detailStatus",
        `Withdrawn ✔ tx ${newTxHash.slice(0, 18)}… — capacity refunded to your wallet.`,
      );
      box.hidden = true;
      btn.disabled = true;
      btn.textContent = "Withdrawn";
    } catch (e) {
      setStatus("detailStatus", e.message || String(e), true);
      confirmBtn.disabled = input.value !== title;
    }
  };
}

/** Rendered from GET /projects/{unid}: full version chain, live/consumed from the index. */
async function renderDetailFromApi(detail, rec) {
  const panel = document.getElementById("detailPanel");
  const live = detail.live_version;

  let manifest = null;
  if (live) {
    try {
      manifest = (await apiGetVersion(live.tx_hash))?.manifest ?? null;
    } catch {
      /* best-effort — the timeline below doesn't depend on this */
    }
  }
  const files = manifest?.files || rec.files || [];

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
          (v) => `
        <li class="${v.tx_hash === detail.live_tx_hash ? "is-live" : ""}">
          <span class="vt-no">v${v.version_no ?? "?"}</span>
          <span class="badge ${v.status === "consumed" ? "dead" : v.status === "pending" ? "pending" : "live"}">${v.status}</span>
          <a class="vt-tx" href="${explorerTxUrl(v.tx_hash)}" target="_blank" rel="noopener">${v.tx_hash.slice(0, 18)}…</a>
          <span class="vt-time">${v.block_time ? new Date(v.block_time).toLocaleString() : "pending"}</span>
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
      ${detail.active ? '<button class="btn btn-ghost btn-small" id="newVersionBtn">Publish new version (consume this cell)</button>' : ""}
      ${detail.active ? withdrawSectionHtml() : ""}
      <span id="detailStatus" class="status"></span>
      <span class="gate-note">Source: global index${API_BASE ? ` (${API_BASE})` : ""}</span>
    </div>`;
  panel.querySelector("h3").textContent = detail.title;
  fpStrip(live?.project_sha256, panel.querySelector(".fp-strip"));

  if (detail.active && detail.live_tx_hash) {
    wireNewVersionButton(panel, {
      txHash: detail.live_tx_hash,
      index: detail.live_index ?? 0,
      genesis: detail.unid,
      title: detail.title,
      sourceUrl: detail.source_url,
      versionNo: live?.version_no,
      ownerAddress: detail.ckb_address,
    });
    wireWithdrawButton(panel, {
      txHash: detail.live_tx_hash,
      index: detail.live_index ?? 0,
      title: detail.title,
      ownerAddress: detail.ckb_address,
    });
  }
}

/** Fallback when the global index is unreachable or doesn't (yet) have this project:
 *  the single version the caller clicked into, read straight from the chain. */
async function renderDetailFromChain(rec) {
  const panel = document.getElementById("detailPanel");
  const chain = await fetchProofFromChain(rec.txHash, rec.index);
  const m = chain.manifest || rec;
  const files = m.files || rec.files || [];

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
      <dt>Owner (lock)</dt><dd>${chain.lockOwner || rec.address || "—"}</dd>
      <dt>Source URL</dt><dd>${m.source ? `<a href="${m.source}" target="_blank" rel="noopener">${m.source}</a>` : "—"}</dd>
      <dt>Transaction</dt><dd><a href="${explorerTxUrl(rec.txHash)}" target="_blank" rel="noopener">${rec.txHash}</a></dd>
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
      ${chain.live !== false ? '<button class="btn btn-ghost btn-small" id="newVersionBtn">Publish new version (consume this cell)</button>' : ""}
      ${chain.live !== false ? withdrawSectionHtml() : ""}
      <span id="detailStatus" class="status"></span>
      <span class="gate-note">${API_BASE ? "Global index unavailable — direct chain lookup." : "Not connected to a global index — direct chain lookup."}</span>
    </div>`;
  panel.querySelector("h3").textContent = m.title || rec.title;
  fpStrip(m.project_sha256 || rec.project_sha256, panel.querySelector(".fp-strip"));

  const ownerAddress = chain.lockOwner || rec.address || null;
  wireNewVersionButton(panel, {
    txHash: rec.txHash,
    index: rec.index,
    genesis: rec.unid,
    title: rec.title,
    sourceUrl: rec.source,
    ownerAddress,
  });
  wireWithdrawButton(panel, {
    txHash: rec.txHash,
    index: rec.index,
    title: rec.title,
    ownerAddress,
  });
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

/** Markup for the withdraw button + its retype-to-confirm panel — shared by both detail renderers. */
function withdrawSectionHtml() {
  return `
    <button class="btn btn-ghost btn-small" id="withdrawBtn">Withdraw (consume, no successor)</button>
    <div id="withdrawConfirm" class="withdraw-confirm" hidden>
      <p class="permanence-note">
        Withdrawing consumes the live cell with <strong>no successor</strong> — the project is
        permanently marked withdrawn (its history stays verifiable, but no version remains
        current). Locked CKB capacity refunds to your wallet.
      </p>
      <label
        >Type the project title to confirm:
        <input id="withdrawTitleInput" type="text" autocomplete="off"
      /></label>
      <div class="submit-row">
        <button id="withdrawConfirmBtn" class="btn btn-primary btn-small" disabled>
          Withdraw project
        </button>
        <button id="withdrawCancelBtn" class="btn btn-ghost btn-small">Cancel</button>
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/* ================================================================== */
/* Verify a dropped file                                              */
/* ================================================================== */
async function verifyFile(file) {
  const h = await sha256Hex(await file.arrayBuffer());
  document.getElementById("searchInput").value = h;
  await runSearch(h, { matchedHash: h });
  document.getElementById("verify").scrollIntoView({ behavior: "smooth" });
}

/** Actually build, sign and send the anchor tx — called directly for a first anchor,
 *  or after the inline confirm step when publishing a new version. */
async function doAnchor() {
  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  try {
    const compact = document.querySelector('input[name="storemode"]:checked').value === "root";
    setStatus("submitStatus", "Building transaction — confirm in your wallet…");
    const prev = state.pendingPrev;
    const { txHash } = await anchorProof({
      compact,
      prevOutPoint: prev?.outPoint || null,
      genesis: prev?.genesis,
      prevTxHash: prev?.rec?.txHash,
    });
    if (prev) {
      // mark the superseded record inactive and link versions in the registry
      const list = loadRegistry();
      const old = list.find((r) => r.txHash === prev.rec.txHash);
      if (old) old.active = false;
      const neu = list.find((r) => r.txHash === txHash);
      if (neu) {
        neu.unid = prev.genesis;
        neu.prev = prev.rec.txHash;
      }
      saveRegistry(list);
      exitVersionMode();
    }
    setStatus("submitStatus", `Anchored ✔ tx ${txHash.slice(0, 18)}… — view it in Search below.`);
    state.entries = [];
    renderManifest();
  } catch (e) {
    setStatus("submitStatus", e.message || String(e), true);
  } finally {
    btn.disabled = false;
  }
}

/* ================================================================== */
/* Wire up the UI                                                     */
/* ================================================================== */
function wireDropzone(el, onFiles) {
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

function init() {
  renderNetworkBadge();
  renderApiSection();
  wireNetworkSwitch();
  updateCreatePanelMode();
  document.getElementById("connectBtn").onclick = connectWallet;

  // hero demo
  wireDropzone(document.getElementById("heroDrop"), async (files) => {
    const h = await sha256Hex(await files[0].arrayBuffer());
    const out = document.getElementById("heroHashOut");
    out.hidden = false;
    out.querySelector("[data-hash]").textContent = h;
    fpStrip(h, out.querySelector("[data-fp]"));
    document.getElementById("heroSearchBtn").onclick = () => {
      document.getElementById("searchInput").value = h;
      runSearch(h, { matchedHash: h });
      document.getElementById("verify").scrollIntoView({ behavior: "smooth" });
    };
  });

  // source tabs
  document.querySelectorAll(".src-tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".src-tab").forEach((t) => t.classList.remove("is-active"));
      document.querySelectorAll(".src-pane").forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.querySelector(`[data-pane="${tab.dataset.src}"]`).classList.add("is-active");
    };
  });
  document.querySelectorAll("[data-open]").forEach((btn) => {
    btn.onclick = () => document.getElementById(btn.dataset.open).click();
  });
  document.getElementById("filesInput").onchange = (e) => addFiles(e.target.files);
  document.getElementById("folderInput").onchange = (e) => addFiles(e.target.files);
  document.getElementById("ghFetchBtn").onclick = () =>
    addGithubRepo(document.getElementById("ghRepo").value).catch((e) =>
      setStatus("submitStatus", e.message, true),
    );
  document.getElementById("urlFetchBtn").onclick = () =>
    addUrl(document.getElementById("urlInput").value).catch((e) =>
      setStatus("submitStatus", e.message, true),
    );
  document.getElementById("hashAddBtn").onclick = () =>
    addPastedHashes(document.getElementById("hashPaste").value);
  document.getElementById("clearBtn").onclick = () => {
    state.entries = [];
    exitVersionMode();
    document.getElementById("anchorConfirm").hidden = true;
    renderManifest();
    setStatus("submitStatus", "");
  };
  document.getElementById("cancelVersionBtn").onclick = (e) => {
    e.preventDefault();
    exitVersionMode();
    document.getElementById("anchorConfirm").hidden = true;
    setStatus("submitStatus", "");
  };

  // anchor — first anchors go straight to the wallet; publishing a new
  // version (consuming the live cell) gets one extra inline confirm step.
  document.getElementById("submitBtn").onclick = () => {
    const prev = state.pendingPrev;
    if (!prev) {
      doAnchor();
      return;
    }
    document.getElementById("anchorConfirmText").textContent =
      `This will consume ${typeof prev.versionNo === "number" ? `v${prev.versionNo}` : "the current version"} ` +
      `(tx ${prev.rec.txHash.slice(0, 14)}…) and create the next version. The old version remains ` +
      `permanently verifiable as superseded; its locked CKB returns to your wallet.`;
    document.getElementById("anchorConfirm").hidden = false;
  };
  document.getElementById("anchorConfirmYes").onclick = () => {
    document.getElementById("anchorConfirm").hidden = true;
    doAnchor();
  };
  document.getElementById("anchorConfirmNo").onclick = () => {
    document.getElementById("anchorConfirm").hidden = true;
  };

  // search & verify
  document.getElementById("searchBtn").onclick = () => {
    const q = document.getElementById("searchInput").value.trim();
    runSearch(q);
  };
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("searchBtn").click();
  });
  wireDropzone(document.getElementById("verifyDrop"), (files) => verifyFile(files[0]));

  document.getElementById("projTitle").addEventListener("input", () => {
    renderManifest();
    if (state.pendingPrev) updateCreatePanelMode();
  });
}

init();
