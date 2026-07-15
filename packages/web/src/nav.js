/**
 * VeriCell — mobile nav toggle (phase 8).
 *
 * Below ~640px, `.nav-links` collapses behind `#navToggle` (see style.css).
 * Self-wiring on import, same pattern as theme.js, so every entry that has
 * a `.topnav` (main.js, verify.js) gets the same behavior without repeating
 * the wiring. No-ops if the page has no `#navToggle` (legal pages).
 */
function closeMenu(toggle, links) {
  links.classList.remove("is-open");
  toggle.setAttribute("aria-expanded", "false");
}

function wireMobileNav() {
  const toggle = document.getElementById("navToggle");
  const links = document.getElementById("navLinks");
  if (!toggle || !links) return;

  function onOutsideClick(e) {
    if (links.contains(e.target) || e.target === toggle) return;
    closeMenu(toggle, links);
    document.removeEventListener("click", onOutsideClick);
  }

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !links.classList.contains("is-open");
    links.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) document.addEventListener("click", onOutsideClick);
    else document.removeEventListener("click", onOutsideClick);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !links.classList.contains("is-open")) return;
    closeMenu(toggle, links);
    document.removeEventListener("click", onOutsideClick);
    toggle.focus();
  });

  links.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => {
      closeMenu(toggle, links);
      document.removeEventListener("click", onOutsideClick);
    });
  });
}

wireMobileNav();
