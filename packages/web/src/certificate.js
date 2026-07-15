/**
 * VeriCell — downloadable proof certificate (phase 4).
 *
 * Two formats, one assembled data structure (`resolveCertificateData`) — only the
 * rendering differs:
 *   - HTML: a single self-contained file, inline CSS only, an inline-SVG QR code
 *     (no external requests — renders and prints fully offline), `@media print`
 *     rules for a clean A4 printout.
 *   - PDF: real selectable text laid out with pdf-lib, paginated for A4. pdf-lib is
 *     dynamically imported only when a PDF is requested, so it never touches the
 *     main bundle.
 * This is the one certificate implementation, shared by the anchor-success
 * confirmation (main.js) and every project/version detail view (main.js's owner
 * detail, verify.js's read-only detail) — see `search.js`'s
 * `renderDetailFromApi`/`renderDetailFromChain`, which both call into this module
 * rather than keeping their own copies.
 */
import QRCode from "qrcode";
import { fetchProofFromChain, explorerTxUrl, escapeHtml } from "./search.js";

/** The printed/QR-encoded canonical link always points at production, even
 *  from a localhost or testnet build — never `location.origin`. A certificate
 *  generated while developing must still resolve for whoever it's handed to. */
export const CANONICAL_ORIGIN = "https://vericell.net";

export function canonicalUnidUrl(unid) {
  return `${CANONICAL_ORIGIN}/status/unid/${encodeURIComponent(unid)}`;
}

function shortUnid(unid) {
  return unid.replace(/^0x/, "").slice(0, 10);
}

function triggerDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Disables `btn` and swaps in `busyText` for the duration of `fn()` — the
 *  chain lookup a certificate/manifest download needs takes a moment, and
 *  every call site (anchor-success, both detail views) wants the same
 *  "don't double-click while this is in flight" behavior. `btn` may be null
 *  (nothing to disable). */
export async function runBusy(btn, busyText, fn) {
  if (!btn) return fn();
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/** Assembles everything a certificate/manifest needs from whatever the caller
 *  already knows plus a fresh chain lookup. `knownManifest` lets a
 *  just-anchored caller (main.js) skip re-deriving the manifest it already
 *  holds in memory; block time and owner lock are always re-checked against
 *  the chain, since a certificate must reflect the *current* committed state
 *  even when regenerated long after anchoring. `active`/`successor` are only
 *  ever known by the caller (the version-chain source of truth is the API
 *  index or the create-flow's own bookkeeping, not a single chain lookup),
 *  so they're passed straight through. */
async function resolveCertificateData({
  client,
  network,
  unid,
  txHash,
  index = 0,
  versionNo = null,
  active = null,
  successor = null,
  title = null,
  sourceUrl = null,
  knownManifest = null,
}) {
  const chain = await fetchProofFromChain(client, txHash, index);
  const manifest = knownManifest || chain.manifest || {};
  return {
    network,
    unid,
    txHash,
    index,
    versionNo,
    active,
    successor,
    title: manifest.title || title || "Untitled project",
    sourceUrl: manifest.source || sourceUrl || null,
    projectHash: manifest.project_sha256 || null,
    merkleRoot: manifest.merkle_root || null,
    count: manifest.count ?? (manifest.files ? manifest.files.length : null),
    files: manifest.files || null,
    createdAt: manifest.created || null,
    ownerAddress: chain.lockOwner || null,
    blockTime: chain.blockTime || null,
    manifest,
  };
}

function brandMarkSvg() {
  return `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
    <rect x="2" y="2" width="20" height="20" rx="3" fill="none" stroke="#10201a" stroke-width="2" />
    <rect x="7" y="7" width="10" height="10" rx="1" fill="#10201a" />
  </svg>`;
}

/** Full-bleed "this is not mainnet" treatment — a top banner plus a repeated
 *  diagonal watermark behind the content, so a testnet certificate cannot be
 *  mistaken for a mainnet one at a glance, on screen or on a printed page. */
function networkNoticeHtml(network) {
  if (network === "mainnet") return { banner: "", watermark: "" };
  const label = network.toUpperCase();
  return {
    banner: `<div class="net-banner">⚠ ${label} CERTIFICATE — anchored on the Nervos CKB ${network}. Test CKB has no monetary value; this is <strong>not</strong> a mainnet proof.</div>`,
    watermark: `<div class="watermark" aria-hidden="true">${label}&nbsp;&nbsp;${label}&nbsp;&nbsp;${label}&nbsp;&nbsp;${label}</div>`,
  };
}

function statusHtml(data) {
  if (data.active === false) {
    return data.successor
      ? `<span class="badge dead">SUPERSEDED</span> — replaced by ${
          typeof data.successor.versionNo === "number"
            ? `v${data.successor.versionNo}`
            : "a later version"
        }: unid <code>${escapeHtml(data.successor.unid)}</code>, tx
        <code>${escapeHtml(data.successor.txHash)}</code>
        (<a href="${canonicalUnidUrl(data.successor.unid)}">${canonicalUnidUrl(data.successor.unid)}</a>)`
      : `<span class="badge dead">SUPERSEDED</span> — a later version now exists; look the project up at the verification link below to find it.`;
  }
  if (data.active === true)
    return `<span class="badge live">LIVE</span> — this is the current version.`;
  return `<span class="badge">STATUS UNKNOWN</span> — could not be confirmed at generation time; use the verification link below.`;
}

function blockTimeHtml(data) {
  if (data.blockTime) {
    return `${data.blockTime.toISOString()} <span class="fine">(block-committed, authoritative)</span>`;
  }
  const broadcastAt = data.createdAt ? new Date(data.createdAt) : new Date();
  return `pending — broadcast at ${broadcastAt.toLocaleString()} <span class="fine">(not yet committed to a block; re-generate this certificate later for the confirmed timestamp)</span>`;
}

/** Plain-text equivalents of `statusHtml`/`blockTimeHtml` for the PDF renderer, which
 *  draws its own text runs rather than injecting markup — same branches, no tags. */
function statusText(data) {
  if (data.active === false) {
    return data.successor
      ? `SUPERSEDED — replaced by ${
          typeof data.successor.versionNo === "number" ? `v${data.successor.versionNo}` : "a later version"
        }: unid ${data.successor.unid}, tx ${data.successor.txHash} (${canonicalUnidUrl(data.successor.unid)})`
      : `SUPERSEDED — a later version now exists; look the project up at the verification link below to find it.`;
  }
  if (data.active === true) return `LIVE — this is the current version.`;
  return `STATUS UNKNOWN — could not be confirmed at generation time; use the verification link below.`;
}

function blockTimeText(data) {
  if (data.blockTime) return `${data.blockTime.toISOString()} (block-committed, authoritative)`;
  const broadcastAt = data.createdAt ? new Date(data.createdAt) : new Date();
  return `pending — broadcast at ${broadcastAt.toLocaleString()} (not yet committed to a block; re-generate this certificate later for the confirmed timestamp)`;
}

function filesTableHtml(data) {
  if (!data.files || !data.files.length) {
    return `<p class="fine">Compact proof — individual file hashes are represented by the Merkle root only; no per-file manifest was anchored.</p>`;
  }
  const rows = data.files
    .map((f) => `<tr><td>${escapeHtml(f.p)}</td><td class="mono">${escapeHtml(f.h)}</td></tr>`)
    .join("");
  return `<table class="files">
    <thead><tr><th>Path</th><th>SHA-256</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function renderCertificateHtml(data) {
  const url = canonicalUnidUrl(data.unid);
  const qrSvg = await QRCode.toString(url, {
    type: "svg",
    margin: 1,
    width: 176,
    color: { dark: "#10201a", light: "#ffffffff" },
  }).catch(() => "");
  const notice = networkNoticeHtml(data.network);
  const explorerLink = explorerTxUrl(data.network, data.txHash);
  const generatedAt = new Date().toISOString();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>VeriCell certificate — ${escapeHtml(data.title)}${
    typeof data.versionNo === "number" ? ` v${data.versionNo}` : ""
  }</title>
<style>
  :root {
    --ink: #10201a;
    --muted: #5a6b63;
    --line: #dde5df;
    --accent-ink: #00614a;
    --accent-soft: #e2f5ee;
    --danger: #c04a3a;
    --paper: #f7f9f7;
  }
  * { box-sizing: border-box; }
  html, body {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: Georgia, "Times New Roman", serif;
    font-size: 15px;
    line-height: 1.55;
  }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
  .fine { color: var(--muted); font-size: 0.8em; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-all;
    font-size: 0.85em;
  }
  a { color: var(--accent-ink); overflow-wrap: anywhere; word-break: break-word; }
  h1, h2 {
    font-family: ui-sans-serif, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.2;
  }
  .net-banner {
    background: #fff1c2;
    color: #6b4c00;
    border-bottom: 3px solid #e8c65a;
    padding: 0.7rem 1.2rem;
    font-family: ui-sans-serif, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-weight: 700;
    text-align: center;
    font-size: 0.95rem;
  }
  .cert-page {
    position: relative;
    max-width: 860px;
    margin: 0 auto;
    padding: 2.2rem 2.4rem 3rem;
    overflow: hidden;
  }
  .watermark {
    position: absolute;
    inset: 0;
    z-index: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    transform: rotate(-28deg) scale(1.4);
    color: #c04a3a;
    opacity: 0.1;
    font-family: ui-sans-serif, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-weight: 800;
    font-size: 2.6rem;
    letter-spacing: 0.05em;
    pointer-events: none;
    user-select: none;
  }
  .cert-content { position: relative; z-index: 1; }
  .cert-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding-top: 1.4rem;
  }
  .cert-head .brand-name {
    font-family: ui-sans-serif, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-weight: 700;
    font-size: 1.3rem;
  }
  .tagline {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.8rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent-ink);
    margin: 0.6rem 0 1.6rem;
  }
  h1 { font-size: 1.5rem; margin: 0 0 0.2rem; }
  .status-line { margin: 0 0 1.4rem; font-size: 0.95rem; }
  .badge {
    display: inline-block;
    border-radius: 4px;
    font-size: 0.72rem;
    font-weight: 700;
    padding: 0.15rem 0.5rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #eef1ef;
    color: var(--muted);
  }
  .badge.live { background: var(--accent-soft); color: var(--accent-ink); }
  .badge.dead { background: #f3e3e0; color: var(--danger); }
  section.block {
    border-top: 1px solid var(--line);
    padding: 1.1rem 0;
  }
  section.block h2 {
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 0.7rem;
  }
  dl.kv {
    display: grid;
    grid-template-columns: 190px 1fr;
    gap: 0.35rem 1rem;
    margin: 0;
    font-size: 0.88rem;
  }
  dl.kv dt { color: var(--muted); }
  dl.kv dd { margin: 0; }
  table.files {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
    margin-top: 0.4rem;
  }
  table.files th {
    text-align: left;
    border-bottom: 1.5px solid var(--ink);
    padding: 0.3rem 0.5rem;
    font-family: ui-sans-serif, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  table.files td {
    border-bottom: 1px solid var(--line);
    padding: 0.3rem 0.5rem;
    vertical-align: top;
    word-break: break-all;
  }
  .verify-row {
    display: flex;
    align-items: flex-start;
    gap: 1.5rem;
    flex-wrap: wrap;
  }
  .verify-links { flex: 1; min-width: 260px; }
  .verify-links p { margin: 0 0 0.6rem; }
  .qr-box {
    background: #fff;
    padding: 0.6rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    flex-shrink: 0;
  }
  .qr-box svg { display: block; width: 132px; height: 132px; }
  .cert-footer {
    margin-top: 1.4rem;
    font-size: 0.76rem;
    color: var(--muted);
  }
  @media print {
    body { background: #fff; }
    .cert-page { max-width: none; padding: 0.4in 0.5in; }
    @page { size: A4; margin: 12mm; }
    section.block { break-inside: avoid; }
    a { color: var(--ink); text-decoration: underline; }
  }
</style>
</head>
<body>
${notice.banner}
<div class="cert-page">
  ${notice.watermark}
  <div class="cert-content">
    <div class="cert-head">
      ${brandMarkSvg()}
      <span class="brand-name">VeriCell</span>
    </div>
    <p class="tagline">Proof of Existence, Integrity, Ownership and Time</p>

    <h1>${escapeHtml(data.title)}</h1>
    <p class="status-line">
      ${typeof data.versionNo === "number" ? `Version ${data.versionNo} · ` : ""}Network:
      <strong>${data.network.toUpperCase()}</strong> · ${statusHtml(data)}
    </p>
    ${
      data.sourceUrl
        ? `<p class="fine">Source: <a href="${escapeHtml(data.sourceUrl)}">${escapeHtml(data.sourceUrl)}</a></p>`
        : ""
    }

    <section class="block">
      <h2>Anchored data</h2>
      <dl class="kv">
        <dt>Project SHA-256</dt><dd class="mono">${data.projectHash ? escapeHtml(data.projectHash) : "—"}</dd>
        <dt>Merkle root</dt><dd class="mono">${data.merkleRoot ? escapeHtml(data.merkleRoot) : "—"}</dd>
        <dt>File count</dt><dd>${data.count ?? "—"}</dd>
      </dl>
      ${filesTableHtml(data)}
    </section>

    <section class="block">
      <h2>Chain record</h2>
      <dl class="kv">
        <dt>Project ID (UNID)</dt><dd class="mono">${escapeHtml(data.unid)}</dd>
        <dt>Transaction hash</dt><dd class="mono">${escapeHtml(data.txHash)}</dd>
        <dt>Cell out-point</dt><dd class="mono">${escapeHtml(data.txHash)} · output #${data.index}</dd>
        <dt>Owner lock (CKB address)</dt><dd class="mono">${data.ownerAddress ? escapeHtml(data.ownerAddress) : "—"}</dd>
        <dt>Block timestamp</dt><dd>${blockTimeHtml(data)}</dd>
      </dl>
    </section>

    <section class="block">
      <h2>Verify this certificate</h2>
      <div class="verify-row">
        <div class="verify-links">
          <p>Canonical verification link:<br /><a href="${url}">${url}</a></p>
          <p>Block-explorer transaction link:<br /><a href="${explorerLink}">${explorerLink}</a></p>
        </div>
        <div class="qr-box">${qrSvg}</div>
      </div>
    </section>

    <p class="cert-footer">
      This certificate is generated client-side from data written to the Nervos CKB blockchain. It
      proves that the wallet controlling the owner lock above knew the listed file hashes at the
      block timestamp shown — it is not a claim of legal authorship. Generated ${generatedAt} at
      ${CANONICAL_ORIGIN}. Certificates are regenerable at any time from the project's verification
      link; this file's content reflects chain state as of generation time.
    </p>
  </div>
</div>
</body>
</html>
`;
}

/** Downloads the self-contained certificate HTML file for one version (live
 *  or consumed) of a project. See `resolveCertificateData` for the parameter
 *  contract; `btn`, if given, shows a busy state while the chain is queried. */
export async function downloadCertificate(params) {
  const { btn, ...rest } = params;
  return runBusy(btn, "Generating…", async () => {
    const data = await resolveCertificateData(rest);
    const html = await renderCertificateHtml(data);
    triggerDownload(
      `vericell-certificate-${shortUnid(data.unid)}-v${data.versionNo ?? "x"}.html`,
      html,
      "text/html",
    );
    return data;
  });
}

function hexToRgb01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function dataUrlToBytes(dataUrl) {
  const binary = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** pdf-lib's `widthOfTextAtSize` for the non-embedded standard-14 fonts reports the
 *  official AFM metrics, but viewers without real Helvetica/Courier installed (e.g.
 *  Chromium's built-in PDF viewer on Linux) substitute a similar-but-wider font and
 *  render noticeably wider than that — measured ~15-20% wider for Helvetica on a
 *  realistic file-path string. Wrap decisions use this padded width so a column
 *  that "fits" per the AFM numbers still fits in a viewer that renders it wider. */
const PDF_WIDTH_SAFETY = 1.3;

/** Greedy word-wrap for pdf-lib text runs that also hard-breaks any single token
 *  (a hash, a UNID, a URL) wider than `maxWidth` — the PDF equivalent of the HTML
 *  certificate's `overflow-wrap: anywhere` treatment for the same long, space-free
 *  strings, so a manifest hash or canonical link can never run off the page. */
function wrapPdfText(text, font, size, maxWidth) {
  const widthOf = (s) => font.widthOfTextAtSize(s, size) * PDF_WIDTH_SAFETY;
  const lines = [];
  for (const rawLine of String(text).split("\n")) {
    let line = "";
    for (const word of rawLine.split(" ")) {
      let remaining = word;
      while (widthOf(remaining) > maxWidth) {
        let cut = remaining.length;
        while (cut > 1 && widthOf(remaining.slice(0, cut)) > maxWidth) cut--;
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
      }
      const attempt = line ? `${line} ${remaining}` : remaining;
      if (!line || widthOf(attempt) <= maxWidth) {
        line = attempt;
      } else {
        lines.push(line);
        line = remaining;
      }
    }
    lines.push(line);
  }
  return lines;
}

const PDF_PAGE_W = 595.28; // A4, points
const PDF_PAGE_H = 841.89;
const PDF_MARGIN = 48;

/** Renders the same `resolveCertificateData` output the HTML certificate uses into a
 *  real-text, paginated A4 PDF — pdf-lib is dynamically imported here so it never
 *  loads (or sits in the main bundle) unless a PDF is actually requested. Layout
 *  mirrors the HTML certificate section-for-section (branding, network banner,
 *  status, anchored data + manifest table, chain record, verify/QR, footer) with the
 *  same "QR never collides with the link text" fix: the link column is wrapped to a
 *  fixed width that excludes the QR box, rather than letting long URLs overflow. */
async function renderCertificatePdf(data) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");

  const url = canonicalUnidUrl(data.unid);
  const explorerLink = explorerTxUrl(data.network, data.txHash);
  const qrDataUrl = await QRCode.toDataURL(url, {
    margin: 1,
    width: 300,
    color: { dark: "#10201a", light: "#ffffffff" },
  }).catch(() => null);

  const doc = await PDFDocument.create();
  doc.setTitle(
    `VeriCell certificate — ${data.title}${typeof data.versionNo === "number" ? ` v${data.versionNo}` : ""}`,
  );
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const qrImage = qrDataUrl ? await doc.embedPng(dataUrlToBytes(qrDataUrl)) : null;

  const ink = rgb(...hexToRgb01("#10201a"));
  const muted = rgb(...hexToRgb01("#5a6b63"));
  const accent = rgb(...hexToRgb01("#00614a"));
  const danger = rgb(...hexToRgb01("#c04a3a"));
  const lineColor = rgb(...hexToRgb01("#dde5df"));
  const warnBg = rgb(...hexToRgb01("#fff1c2"));
  const warnInk = rgb(...hexToRgb01("#6b4c00"));
  const white = rgb(1, 1, 1);

  const contentW = PDF_PAGE_W - PDF_MARGIN * 2;
  let page = doc.addPage([PDF_PAGE_W, PDF_PAGE_H]);
  let y = PDF_PAGE_H - PDF_MARGIN;

  function addPage() {
    page = doc.addPage([PDF_PAGE_W, PDF_PAGE_H]);
    y = PDF_PAGE_H - PDF_MARGIN;
  }
  function ensure(h, onBreak) {
    if (y - h < PDF_MARGIN) {
      addPage();
      onBreak?.();
    }
  }
  function wrapped(str, opts = {}) {
    const { size = 10, f = font, color = ink, maxWidth = contentW, x = PDF_MARGIN, lineGap = 3 } = opts;
    for (const l of wrapPdfText(str, f, size, maxWidth)) {
      ensure(size + lineGap);
      page.drawText(l, { x, y: y - size, size, font: f, color });
      y -= size + lineGap;
    }
  }
  function rule(gapAfter = 10) {
    ensure(gapAfter + 1);
    page.drawLine({
      start: { x: PDF_MARGIN, y },
      end: { x: PDF_PAGE_W - PDF_MARGIN, y },
      thickness: 1,
      color: lineColor,
    });
    y -= gapAfter;
  }
  function sectionHeader(title) {
    rule(14);
    ensure(9 + 10);
    page.drawText(title.toUpperCase(), { x: PDF_MARGIN, y: y - 9, size: 9, font: bold, color: muted });
    y -= 9 + 10;
  }
  const KV_LABEL_W = 150;
  function kv(label, value, opts = {}) {
    const size = opts.size ?? 9.5;
    const f = opts.f ?? mono;
    const lines = wrapPdfText(value ?? "—", f, size, contentW - KV_LABEL_W);
    lines.forEach((l, i) => {
      ensure(size + 4);
      if (i === 0) page.drawText(label, { x: PDF_MARGIN, y: y - size, size, font, color: muted });
      page.drawText(l, { x: PDF_MARGIN + KV_LABEL_W, y: y - size, size, font: f, color: ink });
      y -= size + 4;
    });
  }

  // Network banner — page 1 only, mirrors the HTML certificate's top banner.
  if (data.network !== "mainnet") {
    const label = data.network.toUpperCase();
    const bannerText = `${label} CERTIFICATE — anchored on the Nervos CKB ${data.network}. Test CKB has no monetary value; this is NOT a mainnet proof.`;
    const bannerLines = wrapPdfText(bannerText, bold, 10, PDF_PAGE_W - 40);
    const bannerH = bannerLines.length * 13 + 14;
    page.drawRectangle({ x: 0, y: PDF_PAGE_H - bannerH, width: PDF_PAGE_W, height: bannerH, color: warnBg });
    let by = PDF_PAGE_H - 10;
    for (const l of bannerLines) {
      const tw = bold.widthOfTextAtSize(l, 10);
      page.drawText(l, { x: (PDF_PAGE_W - tw) / 2, y: by - 10, size: 10, font: bold, color: warnInk });
      by -= 13;
    }
    y = PDF_PAGE_H - bannerH - 16;
  }

  wrapped("VeriCell", { size: 18, f: bold, color: ink, lineGap: 4 });
  wrapped("PROOF OF EXISTENCE, INTEGRITY, OWNERSHIP AND TIME", { size: 8, f: mono, color: accent, lineGap: 2 });
  y -= 6;

  wrapped(data.title, { size: 17, f: bold, color: ink, lineGap: 3 });
  y -= 2;

  const versionPrefix = typeof data.versionNo === "number" ? `Version ${data.versionNo} · ` : "";
  wrapped(`${versionPrefix}Network: ${data.network.toUpperCase()}`, { size: 10, color: ink, lineGap: 3 });
  wrapped(statusText(data), {
    size: 9.5,
    f: data.active === false ? bold : font,
    color: data.active === false ? danger : data.active === true ? accent : muted,
    lineGap: 3,
  });
  y -= 4;

  if (data.sourceUrl) {
    wrapped(`Source: ${data.sourceUrl}`, { size: 8.5, color: muted, lineGap: 2 });
    y -= 4;
  }

  sectionHeader("Anchored data");
  kv("Project SHA-256", data.projectHash);
  kv("Merkle root", data.merkleRoot);
  kv("File count", data.count != null ? String(data.count) : null, { f: font });
  y -= 6;

  if (!data.files || !data.files.length) {
    wrapped(
      "Compact proof — individual file hashes are represented by the Merkle root only; no per-file manifest was anchored.",
      { size: 8.5, color: muted, lineGap: 2 },
    );
  } else {
    const pathColW = 190;
    const colGap = 20;
    const hashColW = contentW - pathColW - colGap;
    const rowSize = 8.5;
    const rowLineH = rowSize + 2.5;
    function drawTableHeader() {
      ensure(rowLineH + 6);
      page.drawText("Path", { x: PDF_MARGIN, y: y - 9, size: 9, font: bold, color: ink });
      page.drawText("SHA-256", { x: PDF_MARGIN + pathColW + colGap, y: y - 9, size: 9, font: bold, color: ink });
      y -= 9 + 4;
      page.drawLine({
        start: { x: PDF_MARGIN, y },
        end: { x: PDF_PAGE_W - PDF_MARGIN, y },
        thickness: 1.2,
        color: ink,
      });
      y -= 8;
    }
    drawTableHeader();
    for (const f of data.files) {
      const pathLines = wrapPdfText(f.p, font, rowSize, pathColW);
      const hashLines = wrapPdfText(f.h, mono, rowSize, hashColW);
      const rowLines = Math.max(pathLines.length, hashLines.length);
      for (let i = 0; i < rowLines; i++) {
        ensure(rowLineH, drawTableHeader);
        if (pathLines[i]) page.drawText(pathLines[i], { x: PDF_MARGIN, y: y - rowSize, size: rowSize, font, color: ink });
        if (hashLines[i])
          page.drawText(hashLines[i], {
            x: PDF_MARGIN + pathColW + colGap,
            y: y - rowSize,
            size: rowSize,
            font: mono,
            color: ink,
          });
        y -= rowLineH;
      }
      ensure(6);
      page.drawLine({
        start: { x: PDF_MARGIN, y: y + 4 },
        end: { x: PDF_PAGE_W - PDF_MARGIN, y: y + 4 },
        thickness: 0.5,
        color: lineColor,
      });
      y -= 2;
    }
  }

  sectionHeader("Chain record");
  kv("Project ID (UNID)", data.unid);
  kv("Transaction hash", data.txHash);
  kv("Cell out-point", `${data.txHash} · output #${data.index}`);
  kv("Owner lock (CKB address)", data.ownerAddress);
  kv("Block timestamp", blockTimeText(data), { f: font });

  sectionHeader("Verify this certificate");
  {
    const qrSize = 108;
    const qrPad = 8;
    const boxSize = qrSize + qrPad * 2;
    const gap = 16;
    const linksColW = qrImage ? contentW - boxSize - gap : contentW;

    ensure(boxSize + 60);
    const sectionTop = y;
    if (qrImage) {
      const boxX = PDF_PAGE_W - PDF_MARGIN - boxSize;
      const boxY = sectionTop - boxSize;
      page.drawRectangle({
        x: boxX,
        y: boxY,
        width: boxSize,
        height: boxSize,
        color: white,
        borderColor: lineColor,
        borderWidth: 1,
      });
      page.drawImage(qrImage, { x: boxX + qrPad, y: boxY + qrPad, width: qrSize, height: qrSize });
    }

    wrapped("Canonical verification link:", { size: 9, color: muted, maxWidth: linksColW, lineGap: 2 });
    wrapped(url, { size: 9, f: mono, color: accent, maxWidth: linksColW, lineGap: 2 });
    y -= 6;
    wrapped("Block-explorer transaction link:", { size: 9, color: muted, maxWidth: linksColW, lineGap: 2 });
    wrapped(explorerLink, { size: 9, f: mono, color: accent, maxWidth: linksColW, lineGap: 2 });

    if (qrImage) y = Math.min(y, sectionTop - boxSize - 8);
  }

  y -= 8;
  wrapped(
    `This certificate is generated client-side from data written to the Nervos CKB blockchain. It proves ` +
      `that the wallet controlling the owner lock above knew the listed file hashes at the block timestamp ` +
      `shown — it is not a claim of legal authorship. Generated ${new Date().toISOString()} at ` +
      `${CANONICAL_ORIGIN}. Certificates are regenerable at any time from the project's verification link; ` +
      `this file's content reflects chain state as of generation time.`,
    { size: 7.5, color: muted, lineGap: 2 },
  );

  return doc.save();
}

/** Downloads the same certificate as `downloadCertificate`, rendered as a paginated
 *  A4 PDF with real selectable text instead of a self-contained HTML file. See
 *  `resolveCertificateData` for the parameter contract — both formats are built from
 *  that one assembled data structure; only the rendering differs. */
export async function downloadCertificatePdf(params) {
  const { btn, ...rest } = params;
  return runBusy(btn, "Generating…", async () => {
    const data = await resolveCertificateData(rest);
    const pdfBytes = await renderCertificatePdf(data);
    triggerDownload(
      `vericell-certificate-${shortUnid(data.unid)}-v${data.versionNo ?? "x"}.pdf`,
      pdfBytes,
      "application/pdf",
    );
    return data;
  });
}

/** A small "Certificate · Manifest" action pair for one version row in a project's
 *  timeline (phase 4's "regenerable, not one-shot" requirement) — identical on the
 *  owner's detail view (main.js) and the read-only `/verify` page, since regenerating
 *  a certificate for a version you can already see isn't an owner-only action. `vctx`
 *  is the same shape `downloadCertificate`/`downloadManifestJson` take. */
export function versionCertActionsHtml(vctx) {
  return `<span class="vt-cert-actions" data-cert-tx="${escapeHtml(vctx.txHash)}">
    <button class="link-btn" type="button" data-cert-action="cert">Certificate</button>
    <span aria-hidden="true"> · </span>
    <button class="link-btn" type="button" data-cert-action="cert-pdf">Certificate (PDF)</button>
    <span aria-hidden="true"> · </span>
    <button class="link-btn" type="button" data-cert-action="manifest">Manifest</button>
  </span>`;
}

/** Wires every `versionCertActionsHtml` row rendered into `panel` — `vctxList` must be in the
 *  same order/identity (matched by tx hash) as the rows were built with. Reports errors into
 *  `panel`'s `#detailStatus` element, shared with the detail view's other actions. */
export function wireVersionCertActions(panel, vctxList) {
  const statusEl = panel.querySelector("#detailStatus");
  const report = (msg, err = false) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle("err", err);
  };
  for (const vctx of vctxList) {
    const wrap = panel.querySelector(`[data-cert-tx="${vctx.txHash}"]`);
    if (!wrap) continue;
    const certBtn = wrap.querySelector('[data-cert-action="cert"]');
    const certPdfBtn = wrap.querySelector('[data-cert-action="cert-pdf"]');
    const manifestBtn = wrap.querySelector('[data-cert-action="manifest"]');
    certBtn.onclick = async () => {
      try {
        await downloadCertificate({ ...vctx, btn: certBtn });
        report("Certificate downloaded ✔");
      } catch (e) {
        report(e.message || String(e), true);
      }
    };
    certPdfBtn.onclick = async () => {
      try {
        await downloadCertificatePdf({ ...vctx, btn: certPdfBtn });
        report("Certificate (PDF) downloaded ✔");
      } catch (e) {
        report(e.message || String(e), true);
      }
    };
    manifestBtn.onclick = async () => {
      try {
        await downloadManifestJson({ ...vctx, btn: manifestBtn });
        report("Manifest downloaded ✔");
      } catch (e) {
        report(e.message || String(e), true);
      }
    };
  }
}

/** Downloads the raw manifest JSON alongside the certificate — the same
 *  on-chain manifest, unformatted, for anyone who wants to script against it
 *  rather than read a certificate. */
export async function downloadManifestJson({
  client,
  txHash,
  index = 0,
  unid,
  versionNo = null,
  knownManifest = null,
  btn = null,
}) {
  return runBusy(btn, "Generating…", async () => {
    const manifest = knownManifest || (await fetchProofFromChain(client, txHash, index)).manifest;
    if (!manifest) throw new Error("Could not read the manifest from chain.");
    triggerDownload(
      `vericell-manifest-${shortUnid(unid)}-v${versionNo ?? "x"}.json`,
      JSON.stringify(manifest, null, 2),
      "application/json",
    );
    return manifest;
  });
}
