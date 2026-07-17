# VeriCell.net — UX improvement pass (phased)

Eight phases, meant to be run as **separate Claude Code sessions/commits**,
in this order. Order is not arbitrary: phase 4 (proof certificate) depends
on phase 2 (confirmation panel) and phase 3 (the /verify URL scheme it links
to); phases 7 (dark mode) and 8 (mobile) must come last because they need to
style/adapt all markup introduced in earlier phases (confirmation panel,
verify page, certificate, "your projects" list, use-cases section). Doing
them first would mean redoing them.

After each phase: run the test suite, `pnpm --filter web build`, manually
smoke-test in the browser, and commit before starting the next phase. Don't
start phase N+1 in the same context/session that did phase N — fresh
context per phase avoids the model losing track of the growing file.

All phases work only in `packages/web`. Read `packages/web/src/main.js`,
`index.html`, and `style.css` fully before editing — extend existing
patterns (vanilla JS + `ccc` client, `localStorage` persistence, the `state`
object, `setStatus()`, `explorerTxUrl()`, `.workmask`/`.panel`/`.btn`
conventions) rather than introducing new ones or a framework.

---

## Phase 1 — Copy change + remove API section

Small, independent, no logic changes. Good warm-up phase.

**1a. Hero copy**

In `index.html`, change:
```html
<p class="eyebrow">Proof of authorship · integrity · time</p>
```
to:
```html
<p class="eyebrow">Proof of Existence, Integrity, Ownership and Time</p>
```
Bump `.eyebrow` `font-size` up one step in `style.css`. Check it doesn't
wrap awkwardly at narrow widths (fine to eyeball now — phase 8 does the
full mobile pass).

**1b. Remove "API & automation" section**

Delete the `<section id="api" class="workmask">...</section>` block from
`index.html` (the one with `curlPrepare` / `curlSubmit` / `curlVerify` /
`apiDocsLink`).

- Keep the "API" link in `.topnav`, but repoint it directly to the
  interactive API docs URL currently assigned to `apiDocsLink`, opening in a
  new tab (`target="_blank" rel="noopener"`) instead of anchoring to `#api`.
- Remove the now-dead JS in `main.js` that populates `curlPrepare` /
  `curlSubmit` / `curlVerify` / `apiDocsLink` and any `#api` anchor wiring.
- Check the footer and anywhere else for stray `#api` references and fix
  them too.

---

## Phase 2 — Submit flow clarity: confirmation, button wording, reset

These three are grouped because they all touch the same submit/version-mode
code path in `main.js` and the same area of the page — doing them together
avoids re-touching the same functions three times.

**2a. Confirmation after anchoring**

The `submitBtn` click handler (~line 1194–1220) calls `anchorProof()`, gets
`txHash`, and only updates `submitStatus` text. Add a persistent confirmation
panel after success:

- Reuse the `.version-banner` / `.inline-confirm` visual language already in
  `style.css` — don't invent a new component style.
- Show the tx hash (truncated, full hash in `title`/copy-to-clipboard) and a
  direct link to the block explorer via the existing `explorerTxUrl()`
  helper (`target="_blank" rel="noopener"`).
- Word it to reflect broadcast, not finality: "Transaction broadcast — view
  on explorer", not anything implying confirmation depth.
- Keep it visible until the user starts a new action (new upload, reset from
  2c, or moving into version mode for the next update) — don't auto-hide it.

**2b. Disambiguate "new project" vs "new version"**

Version-mode logic already exists (`enterVersionMode()`, the button-text
swap around line 857: `Consume vX → anchor vY`). Strengthen it:

- No `prev` in state (brand-new project) → button reads **"Create new
  project"**, not the generic "Anchor proof on CKB".
- In version mode → keep "Consume vX → anchor vY", but add a short
  explanatory line near the button itself (not only in `versionBanner`,
  which is easy to scroll past) — e.g. "This will replace your current live
  version with a new one; the old cell is consumed." — visible without
  scrolling back up.
- Optional but nice: distinct icon/color accent for "new project" vs "new
  version" states so it's scannable, not just readable.

**2c. Full reset without disconnecting the wallet**

`clearBtn` currently only clears create-panel form fields. Add a clearly
labeled "Reset" / "Start over" control (near `clearBtn`, or promoted to the
top bar — your call) that:

- Clears: selected files/folder, hash paste, manifest, search
  input/results, version-mode state (`prev`), submit status, and the new
  confirmation panel from 2a.
- Resets `src-tabs` selection back to "Local files".
- Does **not** touch `state.signer` / `state.address` / connected-wallet UI,
  network switch, or theme setting (phase 7).
- If there's unsaved manifest data in progress, confirm first using the
  existing inline-confirm pattern (`anchorConfirm` / `netConfirm`) — not a
  native `confirm()` dialog.

---

## Phase 3 — Dedicated `/verify` page with deep links

A standalone, professional-looking verification page at
`https://vericell.net/verify` focused **only** on checking a seal — for
third parties who received a proof and want to verify it, not for creating
proofs. This is the page a lawyer, auditor, or downloader lands on, so it
should read as "Proof of Existence, Integrity, Ownership and Time" front and
center (reuse the phase-1a eyebrow line as this page's tagline), with no
wallet-connect, no create panel, no fee copy — just verification.

**Build approach — follow the existing multi-page pattern:**

The repo is already a Vite multi-page build (see `vite.config.js`
`rollupOptions.input`: `main`, `impressum`, `datenschutz`,
`haftungsausschluss`) and the Caddyfile already does
`try_files {path} /index.html`. So:

- Add `verify.html` as a new Vite entry in `rollupOptions.input`, sharing
  the same processed `style.css`, topbar, and footer as `index.html`.
- Add a small `verify.js` (or a shared module) reusing the existing search
  machinery from `main.js` — `apiSearchProjects()`, `apiGetVersion()`,
  `fetchProofFromChain()`, `renderResults()`/detail rendering,
  `explorerTxUrl()`. Extract shared code into a module both entries import
  rather than copy-pasting; keep the read-only client (`state.client`)
  without any signer/wallet code on this page.

**Deep-linkable routes (client-side, path-based):**

The page must be directly callable with a resource in the path. Two path
namespaces, both served by the same `verify.html` entry:

- `https://vericell.net/verify` — the bare search landing page: an empty
  search box that accepts any supported input (unid/tx hash, CKB address,
  or file hash), detects which it is (mirroring the existing
  smart-detection in the search logic), and shows results.
- `https://vericell.net/status/unid/<unid>` — the canonical shareable
  status link for one project. Look it up via `GET /projects/{unid}` and
  render its status: live/consumed, version chain, timestamps, owner lock,
  explorer links.
- `https://vericell.net/status/lock/<ckb-address>` — all projects anchored
  by that address, via `GET /projects?address=...` (same API used by
  phase 5's your-projects list).
- `https://vericell.net/status/hash/<sha256>` — backward hash search via
  the existing `hash` query param (a headline feature; include it even
  though it wasn't in the original list — cheap since the API supports it,
  and it completes the "verify anything you were handed" story). If it
  complicates the phase it may be dropped, but prefer to include it.

Parse the path with `location.pathname` on load (no router library). When
a search is performed on `/verify`, update the URL to the matching
`/status/...` form with `history.pushState` so results are
shareable/bookmarkable.

**Caddy routing:**

The current fallback sends everything to `/index.html`. Add rules in the
`Caddyfile` so `/verify`, `/verify/*`, `/status`, and `/status/*` all serve
`verify.html` (e.g. a `handle` block with `try_files {path} /verify.html`,
or a `rewrite` — match the file's existing style and comment conventions).
Also make sure the Vite **dev server** handles these paths (a small
middleware/historyApiFallback-style config in `vite.config.js`) so the
deep links are testable locally without Docker.

**Nav integration:**

- The "Verify" shortcut in the top banner (`.topnav`) must land on
  `/verify` (currently it presumably anchors to the in-page search section
  — repoint it).
- Keep or remove the in-page search section on `index.html` — your call:
  either keep it as a convenience and have both use the shared module, or
  slim it down to a search box that forwards to `/verify`. Do not
  maintain two diverging implementations.
- On the verify page's result view, each project/version should show its
  canonical shareable URL (`/status/unid/...`) with a copy button.

**URL scheme note:** exactly two namespaces, both serving the same page:
`/verify` is the human-facing search entry point; `/status/unid/<...>`,
`/status/lock/<...>`, `/status/hash/<...>` are the canonical machine- and
share-friendly deep links (these get printed on certificates in phase 4 and
embedded in QR codes, so they must be stable). Don't introduce
`/verify/unid/...`-style duplicates — one canonical deep-link scheme only.

---

## Phase 4 — Downloadable proof certificate after anchoring

Extends the phase-2a confirmation: when a proof is successfully anchored
(new project or new version), offer a **"Download certificate"** button in
the confirmation panel, producing a self-contained file the owner can
archive, print, or hand to a third party.

**Certificate contents:**

- VeriCell.net branding + the "Proof of Existence, Integrity, Ownership and
  Time" line, network name (testnet/mainnet clearly marked — a testnet
  certificate must not be mistakable for a mainnet one).
- Project title, version number, and source URL (if provided).
- The anchored data: project hash, Merkle root, file count, and the file
  manifest (paths + per-file SHA-256) as stored on-chain.
- UNID, transaction hash, cell out-point, owner lock / CKB address,
  block timestamp (or "pending — broadcast at <local time>" if not yet
  committed when generated; prefer fetching the committed block time via
  `state.client` before generating, with a graceful fallback).
- The canonical verification link: `https://vericell.net/status/unid/<unid>`
  (build the origin from `location.origin` in dev, but the production
  domain for the canonical printed link — make this a single config
  constant).
- A **QR code** encoding that verification link (the request said
  "barcode" — implement as QR, which is the standard for URLs; note this
  interpretation in the commit message).
- The block-explorer link as text as well, so the certificate is useful
  even if vericell.net is unreachable.

**Format:**

Prefer a **single self-contained HTML file** (inline CSS, QR embedded as a
data-URI `<img>` or inline SVG, no external requests) — it's
print-friendly (add `@media print` styles), archivable, and needs no heavy
dependency. A client-side PDF (e.g. via a small lib) is acceptable instead
if it produces a cleaner printed result, but do not add a large dependency
to the web bundle for it. For the QR itself, use a small, well-maintained
client-side generator (e.g. the `qrcode` npm package) and generate at
download time — no server round-trip.

Also offer the raw **manifest JSON** as a second download alongside the
certificate (it may already exist in some form — if a manifest
download/copy already exists, consolidate rather than duplicate).

Certificate generation must be reproducible later, not only at anchor
time: add the same "Download certificate" action to the project detail
view (and the verify page's result view from phase 3) for any live or
consumed version, so an owner can regenerate a certificate without
re-anchoring.

---

## Phase 5 — Connected wallet's projects, listed at the bottom

The API already supports this: `GET /projects?address=<addr>` (see
`packages/api/src/server/routes/projects.ts`; client-side helper is
`apiSearchProjects()` in `main.js`).

- After `connectWallet()` succeeds, fetch
  `apiSearchProjects({ address: state.address })`.
- New `<section>` near the bottom of `index.html`, hidden until wallet
  connected.
- Reuse `renderResults()` / existing result-row rendering for consistency —
  parameterize the empty-state copy (e.g. "No projects yet — anchor your
  first one above.") rather than building a parallel render path.
- Refresh this list after a successful anchor (phase 2a) and after a version
  update, so it stays current without a manual page refresh.
- Each row should link to its canonical `/status/unid/<unid>` page
  (phase 3) so owners can grab a shareable verification link straight from
  the list.
- API-down fallback: same local-registry fallback pattern used by search,
  filtered by `state.address` if `ownerAddress` is available on local
  records; otherwise show nothing rather than erroring.

---

## Phase 6 — "Use cases for VeriCell.net" section

New collapsible section, styled consistently with existing `.workmask`
sections (e.g. `#how`), placed where the removed `#api` section used to sit
(phase 1b) so the page keeps its rhythm.

- Structure: heading "Use cases for VeriCell.net", then a list of items showing
  **only a title** each. Clicking a title expands the body below it — prefer
  native `<details>`/`<summary>` for built-in accessibility unless it
  visually clashes with the rest of the page, in which case match the
  reveal pattern already used for `src-tabs`.
- With 18 use cases, don't render all bodies expanded by default or open —
  this needs to stay scannable. Group visually if it helps (e.g. a
  responsive grid/columns of collapsed titles), but each item is
  independently expandable.
- Use the content below verbatim (already final — no placeholders needed
  this time). Keep each body's three sub-parts (intro line, "Useful for"
  list, "Proof provided" list) as the internal structure of the expanded
  panel.

### Use case content

**1. Software releases**
Developers can anchor every release package, installer, source ZIP,
checksum file, and changelog.
*Useful for:* Open-source releases, GitHub release assets, desktop software
installers, mobile app builds, internal enterprise tools, SaaS deployment
bundles.
*Proof provided:* This exact release existed at block time T. The files
were not modified after release. The current live cell shows the latest
official version. Older versions remain verifiable as consumed cells.
*(Note: fits especially well since VeriCell.net already ships CLI, REST API,
and GitHub Actions/CI-CD automation paths.)*

**2. Website and web-app releases**
A team can hash and anchor the compiled frontend build folder before
deployment.
*Useful for:* Static websites, landing pages, web apps, documentation
portals, compliance-sensitive web content.
*Proof provided:* This exact website build existed at time T. A user can
verify whether a live website matches the official anchored version. If the
website changes, the old build becomes a consumed/superseded version.

**3. Legal documents and contracts**
A contract, agreement, signed PDF, or negotiation draft can be hashed
locally and anchored.
*Useful for:* NDAs, service agreements, employment contracts, partnership
agreements, terms and conditions, signed PDFs.
*Proof provided:* This exact document existed at time T. The document has
not changed. The wallet that anchored it is linked to the submitter. Later
versions can be linked as official successors.
*(Wording note: avoid claiming "legal authorship" — this is proof that the
wallet owner knew the hashes at block time, not legal authorship.)*

**4. Invoices, purchase orders, and business records**
Businesses can anchor financial documents without uploading the content.
*Useful for:* Invoices, purchase orders, delivery notes, payment
confirmations, audit files, accounting exports.
*Proof provided:* A business record existed at time T. The record was not
edited after the fact. A later corrected version can be linked while
preserving the old version.

**5. Engineering, CAD, and design files**
Engineering teams can prove versions of technical files.
*Useful for:* CAD files, PCB designs, 3D models, architecture drawings,
manufacturing specs, product designs.
*Proof provided:* This exact design existed at time T. The current
approved design can be identified. Old versions remain traceable. Any file
hash can be searched backward to find the related project/version.
*(This is where backward hash search shines — search any SHA-256 to find
the related project, version, and path.)*

**6. Creative work and copyright evidence**
Creators can anchor drafts and final versions before publishing.
*Useful for:* Music files, lyrics, manuscripts, artwork, videos,
photography, game assets, UI/UX designs.
*Proof provided:* The creator had this exact work at time T. Earlier drafts
and later final versions can be linked. Public publication can happen after
anchoring.

**7. Research, academic papers, and datasets**
Researchers can anchor papers, datasets, source code, and experiment
outputs.
*Useful for:* Preprints, datasets, lab reports, research notebooks,
statistical models, reproducibility packages.
*Proof provided:* The research material existed at time T. Dataset
integrity can be verified later. Updated datasets can be versioned clearly.

**8. AI models, prompts, and datasets**
AI teams can anchor model artifacts, training datasets, prompts, and
evaluation results.
*Useful for:* Model weights, fine-tuning datasets, prompt libraries,
benchmark results, evaluation reports, safety test logs.
*Proof provided:* This model/dataset/prompt existed at time T. The current
approved version is identifiable. Old versions remain auditable.

**9. Supply-chain documentation**
A supplier can anchor certificates and batch documents.
*Useful for:* Certificates of origin, quality-control reports, batch test
results, inspection files, compliance declarations, shipping documents.
*Proof provided:* The certificate existed before shipment or delivery. The
document was not modified. Updated or revoked certificates can be tracked.

**10. Public tenders and procurement**
Organizations can anchor bids, tender documents, and submissions.
*Useful for:* Government tenders, supplier proposals, bid submissions,
evaluation documents, procurement audit trails.
*Proof provided:* A bid existed before the deadline. The submitted document
was not altered later. Revised versions are visible as successors.

**11. Bug reports and vulnerability disclosure**
Security researchers can privately anchor a vulnerability report before
disclosure.
*Useful for:* Bug bounty reports, responsible disclosure, exploit writeups,
security audit findings, patch evidence.
*Proof provided:* The researcher knew the vulnerability at time T. The
report content can later be verified. Updated reports can be versioned.

**12. Journalism and public statements**
Journalists, bloggers, and organizations can anchor published material.
*Useful for:* Articles, press releases, public statements, investigative
evidence bundles, media archives.
*Proof provided:* This version of the article existed at time T. Later
edits are separate versions. Readers can verify whether they're seeing the
current version.

**13. Policies, procedures, and compliance documents**
Companies can anchor internal policies and SOPs.
*Useful for:* HR policies, safety procedures, compliance manuals, ISO
documents, internal guidelines, training materials.
*Proof provided:* This policy version existed at time T. Employees or
auditors can check whether it's still current. Old versions remain
traceable.

**14. Education and certificates**
Schools, trainers, and online course platforms can anchor certificates and
course files.
*Useful for:* Diplomas, certificates, course materials, student
submissions, exam files, assignment evidence.
*Proof provided:* A certificate or submission existed at time T. The
document has not changed. Updated or revoked versions can be shown.

**15. Insurance and claims**
A claimant can anchor photos, documents, and reports.
*Useful for:* Accident photos, damage reports, claim documents, repair
estimates, medical reports.
*Proof provided:* Evidence existed at time T. Files were not modified after
anchoring. Additional evidence can be added as new versions.

**16. Product documentation and manuals**
Manufacturers can anchor manuals and technical documentation.
*Useful for:* User manuals, safety sheets, release notes, firmware
documentation, product specifications.
*Proof provided:* This manual/spec existed at time T. The latest live
version is easy to identify. Old versions remain historically verifiable.

**17. DAO and Web3 governance**
Projects can anchor governance proposals, snapshots, and community
documents.
*Useful for:* DAO proposals, treasury reports, voting documents, protocol
specs, tokenomics documents.
*Proof provided:* The proposal existed before voting. The content was not
changed after community review. New proposal versions are linked
transparently.

**18. API specifications and technical standards**
Teams can anchor OpenAPI specs, schemas, and protocol documents.
*Useful for:* API contracts, database schemas, protocol specs,
configuration files, interface definitions.
*Proof provided:* The technical contract existed at time T. The current
live version is known. Breaking changes become visible through version
history.

---

## Phase 7 — Dark/light mode

No dark-mode support currently exists (no `prefers-color-scheme` usage, no
dark token set). Run this after phases 1–6 so it covers all markup added so
far (confirmation panel, verify page, certificate button, your-projects
list, use-cases section). The theme toggle and persisted choice must also
apply on `verify.html` (and the legal pages if they share the stylesheet) —
share the theme-init snippet across entries, don't duplicate it.

- Add a `[data-theme="dark"]` block in `style.css` mirroring the existing
  `:root` tokens — reuse `--dark: #0c1613` as a base but build a full dark
  palette (`--paper`, `--panel`, `--ink`, `--muted`, `--line`,
  `--accent-soft`, etc.), keeping the same CKB-green `--accent` for brand
  consistency.
- Sun/moon icon toggle button in `.topbar`, near the network badge, matching
  the existing SVG style used for `.brand-mark`.
- Default to `prefers-color-scheme` on first load, then persist the user's
  explicit choice in `localStorage` (same pattern as `NETWORK_STORAGE_KEY`),
  overriding the OS preference once set.
- Verify every component in dark mode, including everything phases 1–6
  added: confirmation banner, reset control, verify-page result views,
  your-projects list, use-cases `<details>` panels, dropzones, code blocks,
  buttons, status messages, inline-confirm dialogs. The downloadable
  certificate (phase 4) is exempt — it keeps its own fixed, print-oriented
  styling regardless of the site theme.

---

## Phase 8 — Mobile responsiveness

Run last, once the final DOM/CSS from phases 1–7 is in place, so breakpoints
are set against the real page rather than a moving target.

No `@media` breakpoints currently exist. Add responsive handling for:

- `.topbar` / `.topnav`: collapse nav links behind a hamburger/menu button
  below ~640px; keep network badge, theme toggle (phase 7), and connect
  button reachable.
- `.hero`: stack `hero-copy` and `hero-demo` vertically on narrow screens.
- `.features`: stack to a single column.
- `.src-tabs`: horizontal scroll or wrap instead of overflow.
- `.manifest` / `.file-list`: long hashes truncate/wrap instead of causing
  page-wide horizontal scroll.
- The confirmation panel (phase 2a), the entire `/verify` page (phase 3 —
  this one especially: it's the page third parties open from a QR code on
  a printed certificate, so mobile is its primary form factor), the
  certificate download flow (phase 4), your-projects list (phase 5), and
  use-cases section (phase 6) all need to hold up at mobile widths — don't
  just check the pre-existing sections.
- Form inputs, buttons, and tap targets sized for touch (min ~44px height).
- Test at 375px, 768px, and 1024px+.

---

## General constraints (all phases)

- Match existing visual language (tokens in `:root`, `--radius`,
  `--display`/`--body`/`--mono` fonts, `.btn` variants) — extend, don't
  duplicate.
- Preserve the non-custodial signing flow: all signing stays client-side via
  `state.signer`; nothing here should route key material through the API.
- Don't break network switching, API-down fallback search, or the
  version-chain/withdraw flow — unrelated to this pass, must keep working.
- End-to-end smoke test after phase 8: wallet connect → create new project →
  confirmation shows with working explorer link → download certificate,
  open it, scan/click its QR link and confirm it lands on
  `/status/unid/<unid>` showing the project as live → project appears in
  your-projects list with a working verify link → open
  `/status/lock/<address>` directly in a fresh incognito tab (no wallet)
  and confirm it lists the project → create a version update →
  button/copy clearly reads as update not new → old version shows as
  consumed on the verify page → reset clears the form but keeps wallet
  connected → toggle dark mode, reload, confirm persistence on both
  `index.html` and `/verify` → resize to 375px, confirm nothing overflows
  on either page.
