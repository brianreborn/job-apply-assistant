/**
 * Soft submit guard: never auto-clicks submit; warns if user submits right after a fill.
 * Does not permanently block legitimate user submissions.
 */
(function () {
  "use strict";

  function isSubmitControl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "button" && (el.type === "submit" || !el.type)) return true;
    if (tag === "input" && (el.type === "submit" || el.type === "image")) return true;
    if (el.getAttribute("role") === "button") {
      const t = (el.innerText || el.value || "").toLowerCase();
      if (/\b(submit|apply|send application|complete application)\b/.test(t)) return true;
    }
    return false;
  }

  function markSubmits() {
    document.querySelectorAll("button, input[type='submit'], input[type='image']").forEach((el) => {
      if (isSubmitControl(el)) {
        el.setAttribute("data-jobapply-no-auto", "1");
        el.setAttribute("title", (el.title || "") + " (JobApply never auto-submits)");
      }
    });
  }

  // Observe SPA re-renders lightly
  const mo = new MutationObserver(() => {
    if (markSubmits._t) clearTimeout(markSubmits._t);
    markSubmits._t = setTimeout(markSubmits, 400);
  });

  if (document.documentElement) {
    markSubmits();
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  document.addEventListener(
    "submit",
    (ev) => {
      const active = document.documentElement.getAttribute("data-jobapply-fill-active");
      if (!active) return;
      // Soft confirm once per fill session
      if (document.documentElement.getAttribute("data-jobapply-submit-warned") === "1") return;
      const ok = window.confirm(
        "JobApply Assistant filled this form but never submits for you.\n\n" +
          "Have you reviewed all fields?\n\n" +
          "OK = continue submitting · Cancel = stay on page"
      );
      document.documentElement.setAttribute("data-jobapply-submit-warned", "1");
      if (!ok) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    },
    true
  );

  document.addEventListener(
    "click",
    (ev) => {
      const t = ev.target?.closest?.("button, input, a, [role='button']");
      if (!t || !isSubmitControl(t)) return;
      // Ensure we never programmatically click these from our scripts
      if (ev.isTrusted === false) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    },
    true
  );
})();
