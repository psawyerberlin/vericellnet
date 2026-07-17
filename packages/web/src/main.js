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
  computeFee,
  getFeeAddress,
  costBreakdown,
  FEE_EXPLAINER_TEXT,
} from "core";
import {
  resolveInitialNetwork,
  makeChainClient,
  NETWORK_STORAGE_KEY,
  explorerTxUrl,
  renderNetworkBadge,
  wireNetworkSwitch,
  wireApiNavLink,
  wireDropzone,
  fpStrip,
  loadRegistry,
  saveRegistry,
  addToRegistry,
  runSearch as sharedRunSearch,
  showProjectDetail,
  renderResults,
  fetchOwnerProjects,
} from "./search.js";
import {
  downloadCertificate,
  downloadCertificatePdf,
  downloadManifestJson,
  versionCertActionsHtml,
  wireVersionCertActions,
} from "./certificate.js";
import "./theme.js";
import "./nav.js";

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
/* Network resolution, the chain client, and search/detail rendering  */
/* are shared with verify.js via ./search.js (phase 3) — no diverging */
/* copies of that machinery between the two pages.                    */
/* ================================================================== */
const state = {
  network: resolveInitialNetwork(),
  client: null, // set below, once state.network is known
  signer: null,
  address: null,
  entries: [], // [{ p: path, h: sha256hex, bytes }]
  pendingPrev: null, // set while the create panel is in "publish new version" mode
  lastCostEstimate: null, // { full, compact } CKB, cached from renderManifest() for the submit-time cost gate
  lastAnchorCert: null, // certificate.js params for the anchor shown in #anchorSuccess (phase 4)
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
/* Wallet (JoyID via CCC — other CCC signers plug in the same way)    */
/* ================================================================== */
async function connectWallet() {
  const btn = document.getElementById("connectBtn");
  try {
    btn.textContent = "Connecting…";
    state.signer = new ccc.JoyId.CkbSigner(
      state.client,
      "VeriCell.net",
      location.origin + "/icon.svg",
    );
    await state.signer.connect();
    state.address = await state.signer.getRecommendedAddress();
    btn.textContent = `${state.address.slice(0, 8)}…${state.address.slice(-6)}`;
    btn.classList.add("is-connected");
    btn.title = state.address;
    document.getElementById("createPanel").classList.remove("is-locked");
    document.getElementById("createGate").textContent = "Wallet connected — you can anchor proofs.";
    showMyProjects();
  } catch (e) {
    btn.textContent = "Connect wallet";
    setStatus("submitStatus", `Wallet connection failed: ${e.message || e}`, true);
  }
}

/* ================================================================== */
/* Service fee — ACP top-up (phase(fee))                              */
/*                                                                     */
/* `web` depends only on `core` + `@ckb-ccc/ccc`, not `chain` (which    */
/* imports node:fs for devnet's system-scripts file and doesn't bundle */
/* cleanly for a browser target — same reason anchorProof/withdrawProof */
/* already hand-build their transactions instead of calling `chain`'s   */
/* builders). This mirrors chain/src/fee.ts's applyServiceFee exactly,  */
/* against the same VERICELL_FEE_ADDRESS_<NETWORK> config (read here    */
/* via its VITE_-prefixed build-time form, core's getFeeAddress).       */
/* ================================================================== */
async function feeLockForWeb(client, network) {
  const address = getFeeAddress(network);
  if (!address) return null;
  const addr = await ccc.Address.fromString(address, client);
  const acpInfo = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
  return ccc.Script.from({
    codeHash: acpInfo.codeHash,
    hashType: acpInfo.hashType,
    args: addr.script.args,
  });
}

async function pickFeeCellWeb(client, feeLock) {
  const candidates = [];
  for await (const cell of client.findCellsByLock(feeLock, null, true)) {
    candidates.push(cell);
    if (candidates.length >= 5) break;
  }
  if (candidates.length === 0) {
    throw new Error(
      "No fee-collection cell found for this network yet — the service fee pool hasn't been set up.",
    );
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** Appends the service-fee ACP top-up leg to `tx` in place, if one is due — see chain/src/fee.ts's applyServiceFee. */
async function applyServiceFeeWeb(client, tx, network) {
  const output0 = tx.outputs[0];
  const amount = computeFee(output0.capacity);
  if (amount === 0n) return { amount: 0n };

  const feeLock = await feeLockForWeb(client, network);
  if (!feeLock) return { amount: 0n };

  const cell = await pickFeeCellWeb(client, feeLock);
  const acpInfo = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
  await tx.addCellDepInfos(client, acpInfo.cellDeps);
  tx.addInput({ previousOutput: cell.outPoint });
  tx.addOutput({ lock: cell.cellOutput.lock, capacity: cell.cellOutput.capacity + amount }, "0x");
  return { amount, cell };
}

/** shannons, formatted as a CKB amount. */
function formatShannons(shannons) {
  const ckb = shannons / 100_000_000n;
  const rem = shannons % 100_000_000n;
  if (rem === 0n) return `${ckb} CKB`;
  const fraction = rem.toString().padStart(8, "0").replace(/0+$/, "");
  return `${ckb}.${fraction} CKB`;
}

/** The full "what this anchor costs" breakdown text — shown before the wallet-confirm step whenever a real service fee applies. */
function costBreakdownText(cost) {
  const feeLine =
    cost.feeConfigured && cost.serviceFeeShannons > 0n
      ? `Service fee: ${formatShannons(cost.serviceFeeShannons)}`
      : "Service fee: none";
  return (
    `Locked capacity: ${formatShannons(cost.lockedCapacityShannons)} (refundable)\n` +
    `Network fee: a small amount set by your wallet\n` +
    `${feeLine}\n\n${FEE_EXPLAINER_TEXT}`
  );
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
  // Must run before completeInputsByCapacity so the wallet's own inputs are
  // collected to cover the service fee amount too, not just the proof cell.
  await applyServiceFeeWeb(state.client, tx, state.network);
  await tx.completeInputsByCapacity(state.signer);
  await tx.completeFeeBy(state.signer, 1000);
  const txHash = await state.signer.sendTransaction(tx);

  addToRegistry(state.network, {
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
/* Input sources                                                      */
/* ================================================================== */
async function addFiles(fileList) {
  hideAnchorSuccess();
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
  hideAnchorSuccess();
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
  hideAnchorSuccess();
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
  hideAnchorSuccess();
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

/* ================================================================== */
/* Runtime network toggle (phase 10b)                                 */
/* ================================================================== */
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
  hideMyProjects();
  const connectBtn = document.getElementById("connectBtn");
  connectBtn.textContent = "Connect wallet";
  connectBtn.classList.remove("is-connected");
  connectBtn.title = "";
  document.getElementById("createPanel").classList.add("is-locked");
  document.getElementById("createGate").textContent =
    `Switched to ${target.toUpperCase()} — reconnect your wallet to create proofs.`;

  renderNetworkBadge(target);

  // The open detail view (if any) belongs to whichever network it was opened
  // from; there's no cross-network mapping for a single tx/unid, so close it
  // rather than show stale or wrong-chain data.
  document.getElementById("detail").hidden = true;
  document.getElementById("detailPanel").innerHTML = "";

  const q = document.getElementById("searchInput").value.trim();
  if (q) await runSearch(q);
  else document.getElementById("searchResults").innerHTML = "";
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
    state.lastCostEstimate = cost;
    document.getElementById("fullCost").textContent =
      `≈ ${cost.full} CKB locked (refundable)${feeHint(cost.full)}`;
    document.getElementById("rootCost").textContent =
      `≈ ${cost.compact} CKB locked (refundable)${feeHint(cost.compact)}`;
  } else {
    state.lastCostEstimate = null;
  }
}

/** " · service fee ≈ X CKB" appended next to a storage-mode's capacity estimate, or "" when none applies. */
function feeHint(capacityCkb) {
  const cost = costBreakdown(BigInt(capacityCkb) * 100_000_000n, state.network);
  if (!cost.feeConfigured || cost.serviceFeeShannons === 0n) return "";
  return ` · service fee ≈ ${formatShannons(cost.serviceFeeShannons)}`;
}

/** Full cost breakdown for whichever storage mode is currently selected, from the cached estimate (`renderManifest`). */
function currentCostBreakdown(compact) {
  const est = state.lastCostEstimate;
  const capacityCkb = est ? (compact ? est.compact : est.full) : 0;
  return costBreakdown(BigInt(capacityCkb) * 100_000_000n, state.network);
}

/** Thin wrapper around the shared search: this page's results link into its
 *  own detail view (owner actions), not the read-only one on /verify. */
function runSearch(q, opts = {}) {
  return sharedRunSearch(state.network, state.client, q, {
    onSelect: showDetail,
    showCanonicalLink: false,
    ...opts,
  });
}

/** Project detail, with this page's owner-only actions (publish new version / withdraw)
 *  layered on top of the shared read-only rendering — see buildOwnerActionsHtml below. */
function showDetail(rec) {
  return showProjectDetail({
    rec,
    network: state.network,
    client: state.client,
    buildActionsHtml: buildOwnerActionsHtml,
    wireActions: wireOwnerActions,
    buildVersionActionsHtml: versionCertActionsHtml,
    wireVersionActions: wireVersionCertActions,
  });
}

/** `ctx` is `{ active, txHash, index, title, sourceUrl, versionNo, ownerAddress, unid }`,
 *  assembled by the shared detail renderer (search.js) from either the API or a chain-only
 *  fallback — only shown/wired when this device's wallet may own the project. */
function buildOwnerActionsHtml(ctx) {
  if (!ctx.active) return "";
  return `<button class="btn btn-ghost btn-small" id="newVersionBtn">Publish new version (consume this cell)</button>${withdrawSectionHtml()}`;
}

function wireOwnerActions(panel, ctx) {
  if (!ctx.active) return;
  wireNewVersionButton(panel, {
    txHash: ctx.txHash,
    index: ctx.index,
    genesis: ctx.unid,
    title: ctx.title,
    sourceUrl: ctx.sourceUrl,
    versionNo: ctx.versionNo,
    ownerAddress: ctx.ownerAddress,
  });
  wireWithdrawButton(panel, {
    txHash: ctx.txHash,
    index: ctx.index,
    title: ctx.title,
    ownerAddress: ctx.ownerAddress,
  });
}

/* ================================================================== */
/* Connected wallet's "Your projects" list (phase 5)                  */
/* ================================================================== */
/** Re-fetches and re-renders the connected wallet's project list, reusing the same
 *  row rendering as global search (renderResults) with its own target container and
 *  empty-state copy. No-ops if no wallet is connected — callers that only fire once a
 *  wallet action succeeded don't need to guard this themselves. */
async function refreshMyProjects() {
  if (!state.address) return;
  const { hits, apiDown } = await fetchOwnerProjects(state.network, state.address);
  renderResults(hits, {
    targetId: "myProjectsResults",
    apiDown,
    network: state.network,
    client: state.client,
    onSelect: showDetail,
    showCanonicalLink: true,
    emptyMessage: "No projects yet — anchor your first one above.",
  });
}

function showMyProjects() {
  document.getElementById("myProjects").hidden = false;
  refreshMyProjects();
}

/** Hides the wallet-scoped "Your projects" section — only called when the connected
 *  wallet itself goes away (network switch forces reconnect), never by the form-scoped
 *  "Start over" reset (phase 2c), which must leave this section alone. */
function hideMyProjects() {
  document.getElementById("myProjects").hidden = true;
  document.getElementById("myProjectsResults").innerHTML = "";
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
  const hint = document.getElementById("submitHint");

  if (!prev) {
    heading.textContent = "Create a project proof";
    cancelBtn.hidden = true;
    banner.hidden = true;
    submitBtn.textContent = "Create new project";
    submitBtn.classList.remove("btn-version");
    hint.hidden = true;
    hint.textContent = "";
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
  submitBtn.classList.add("btn-version");
  hint.hidden = false;
  hint.textContent =
    "This will replace your current live version with a new one; the old cell is consumed.";
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
  hideAnchorSuccess();
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

  const list = loadRegistry(state.network);
  const old = list.find((r) => r.txHash === outPoint.txHash);
  if (old) {
    old.active = false;
    saveRegistry(state.network, list);
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
      refreshMyProjects();
    } catch (e) {
      setStatus("detailStatus", e.message || String(e), true);
      confirmBtn.disabled = input.value !== title;
    }
  };
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

/* ================================================================== */
/* Verify a dropped file                                              */
/* ================================================================== */
async function verifyFile(file) {
  const h = await sha256Hex(await file.arrayBuffer());
  document.getElementById("searchInput").value = h;
  await runSearch(h, { matchedHash: h });
  document.getElementById("verify").scrollIntoView({ behavior: "smooth" });
}

/** Persistent post-anchor confirmation (phase 2a) — stays up until the user starts a new
 *  action (new upload, reset, or entering version mode), not tied to submitStatus's transient text.
 *  `cert` (phase 4) carries everything the certificate/manifest downloads need for *this* anchor —
 *  captured here rather than re-read from the form later, since the title/URL inputs may already
 *  have moved on to the next project by the time the user clicks "Download certificate". */
function showAnchorSuccess(txHash, cert) {
  const box = document.getElementById("anchorSuccess");
  const hashEl = document.getElementById("anchorSuccessHash");
  const link = document.getElementById("anchorSuccessLink");
  hashEl.textContent = `${txHash.slice(0, 18)}…`;
  hashEl.title = txHash;
  link.href = explorerTxUrl(state.network, txHash);
  box.dataset.txHash = txHash;
  state.lastAnchorCert = cert;
  document.getElementById("anchorSuccessCertStatus").textContent = "";
  box.hidden = false;
}

function hideAnchorSuccess() {
  const box = document.getElementById("anchorSuccess");
  box.hidden = true;
  delete box.dataset.txHash;
  state.lastAnchorCert = null;
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
    const { txHash, manifest } = await anchorProof({
      compact,
      prevOutPoint: prev?.outPoint || null,
      genesis: prev?.genesis,
      prevTxHash: prev?.rec?.txHash,
    });
    if (prev) {
      // mark the superseded record inactive and link versions in the registry
      const list = loadRegistry(state.network);
      const old = list.find((r) => r.txHash === prev.rec.txHash);
      if (old) old.active = false;
      const neu = list.find((r) => r.txHash === txHash);
      if (neu) {
        neu.unid = prev.genesis;
        neu.prev = prev.rec.txHash;
      }
      saveRegistry(state.network, list);
      exitVersionMode();
    }
    setStatus("submitStatus", "Anchored ✔ — see the confirmation below, or find it in Search.");
    showAnchorSuccess(txHash, {
      client: state.client,
      network: state.network,
      unid: prev ? prev.genesis : txHash,
      txHash,
      index: 0,
      versionNo: prev ? (typeof prev.versionNo === "number" ? prev.versionNo + 1 : null) : 1,
      active: true,
      title: manifest.title,
      sourceUrl: manifest.source || null,
      knownManifest: manifest,
    });
    refreshMyProjects();
    state.entries = [];
    renderManifest();
  } catch (e) {
    setStatus("submitStatus", e.message || String(e), true);
  } finally {
    btn.disabled = false;
  }
}

/* ================================================================== */
/* Full reset ("Start over", phase 2c) — unlike clearBtn (manifest      */
/* only), this also resets search, src-tabs and the anchor confirmation, */
/* without touching the connected wallet, network or theme.            */
/* ================================================================== */
/** True when there's in-progress proof data a reset would discard. */
function hasUnsavedProofData() {
  return (
    state.entries.length > 0 ||
    !!state.pendingPrev ||
    document.getElementById("projTitle").value.trim() !== "" ||
    document.getElementById("projUrl").value.trim() !== "" ||
    document.getElementById("hashPaste").value.trim() !== ""
  );
}

function performReset() {
  state.entries = [];
  exitVersionMode();
  document.getElementById("projTitle").value = "";
  document.getElementById("projUrl").value = "";
  document.getElementById("hashPaste").value = "";
  document.getElementById("ghRepo").value = "";
  document.getElementById("urlInput").value = "";
  document.getElementById("filesInput").value = "";
  document.getElementById("folderInput").value = "";
  document.getElementById("searchInput").value = "";
  document.getElementById("searchResults").innerHTML = "";
  document.getElementById("anchorConfirm").hidden = true;
  hideAnchorSuccess();
  setStatus("submitStatus", "");

  document.querySelectorAll(".src-tab").forEach((t) => t.classList.remove("is-active"));
  document.querySelectorAll(".src-pane").forEach((p) => p.classList.remove("is-active"));
  document.querySelector('.src-tab[data-src="files"]').classList.add("is-active");
  document.querySelector('.src-pane[data-pane="files"]').classList.add("is-active");

  renderManifest();
}

/* ================================================================== */
/* Wire up the UI                                                     */
/* ================================================================== */
function init() {
  renderNetworkBadge(state.network);
  wireApiNavLink();
  wireNetworkSwitch(() => state.network, switchNetwork);
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
    hideAnchorSuccess();
    renderManifest();
    setStatus("submitStatus", "");
  };
  document.getElementById("cancelVersionBtn").onclick = (e) => {
    e.preventDefault();
    exitVersionMode();
    document.getElementById("anchorConfirm").hidden = true;
    setStatus("submitStatus", "");
  };

  // "Start over" (phase 2c) — confirm first if there's unsaved proof data,
  // via the same inline-confirm pattern as anchorConfirm/netConfirm.
  document.getElementById("resetBtn").onclick = () => {
    if (hasUnsavedProofData()) {
      document.getElementById("resetConfirm").hidden = false;
    } else {
      performReset();
    }
  };
  document.getElementById("resetConfirmYes").onclick = () => {
    document.getElementById("resetConfirm").hidden = true;
    performReset();
  };
  document.getElementById("resetConfirmNo").onclick = () => {
    document.getElementById("resetConfirm").hidden = true;
  };

  // copy the anchored tx hash from the persistent confirmation panel (phase 2a)
  document.getElementById("anchorSuccessCopy").onclick = async () => {
    const box = document.getElementById("anchorSuccess");
    const txHash = box.dataset.txHash;
    if (!txHash) return;
    const btn = document.getElementById("anchorSuccessCopy");
    try {
      await navigator.clipboard.writeText(txHash);
      const original = btn.textContent;
      btn.textContent = "Copied ✔";
      setTimeout(() => (btn.textContent = original), 1500);
    } catch {
      /* clipboard API unavailable — the full hash is still in the element's title */
    }
  };

  // certificate + manifest downloads for the anchor just confirmed (phase 4)
  document.getElementById("anchorSuccessCert").onclick = async () => {
    if (!state.lastAnchorCert) return;
    try {
      await downloadCertificate({
        ...state.lastAnchorCert,
        btn: document.getElementById("anchorSuccessCert"),
      });
      setStatus("anchorSuccessCertStatus", "Certificate downloaded ✔");
    } catch (e) {
      setStatus("anchorSuccessCertStatus", e.message || String(e), true);
    }
  };
  document.getElementById("anchorSuccessCertPdf").onclick = async () => {
    if (!state.lastAnchorCert) return;
    try {
      await downloadCertificatePdf({
        ...state.lastAnchorCert,
        btn: document.getElementById("anchorSuccessCertPdf"),
      });
      setStatus("anchorSuccessCertStatus", "Certificate (PDF) downloaded ✔");
    } catch (e) {
      setStatus("anchorSuccessCertStatus", e.message || String(e), true);
    }
  };
  document.getElementById("anchorSuccessManifest").onclick = async () => {
    if (!state.lastAnchorCert) return;
    try {
      await downloadManifestJson({
        ...state.lastAnchorCert,
        btn: document.getElementById("anchorSuccessManifest"),
      });
      setStatus("anchorSuccessCertStatus", "Manifest downloaded ✔");
    } catch (e) {
      setStatus("anchorSuccessCertStatus", e.message || String(e), true);
    }
  };

  // anchor — a plain first anchor with no service fee due goes straight to
  // the wallet; publishing a new version, or any anchor a real service fee
  // applies to, gets one extra inline confirm step showing what it costs.
  document.getElementById("submitBtn").onclick = () => {
    const prev = state.pendingPrev;
    const compact = document.querySelector('input[name="storemode"]:checked').value === "root";
    const cost = currentCostBreakdown(compact);
    const feeDue = cost.feeConfigured && cost.serviceFeeShannons > 0n;

    if (!prev && !feeDue) {
      doAnchor();
      return;
    }

    const versionText = prev
      ? `This will consume ${typeof prev.versionNo === "number" ? `v${prev.versionNo}` : "the current version"} ` +
        `(tx ${prev.rec.txHash.slice(0, 14)}…) and create the next version. The old version remains ` +
        `permanently verifiable as superseded; its locked CKB returns to your wallet.\n\n`
      : "";
    document.getElementById("anchorConfirmText").textContent =
      versionText + costBreakdownText(cost);
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
