/**
 * Scan application forms for fillable fields with stable ids and labels.
 * Handles common ATS patterns (Greenhouse, Lever, Workday-ish, generic HTML).
 */
(function (global) {
  "use strict";

  const SKIP_TYPES = new Set([
    "hidden",
    "submit",
    "button",
    "image",
    "reset",
    "file",
    "password",
  ]);

  function cssPath(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      cur = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  /**
   * Prefer stable identifiers that survive re-scan without depending on
   * enumeration order when an element has name/id/automation attrs.
   */
  function stableId(el, index) {
    if (el.id) return `id:${el.id}`;
    const auto =
      el.getAttribute("data-automation-id") ||
      el.getAttribute("data-testid") ||
      el.getAttribute("data-qa") ||
      el.getAttribute("data-field");
    if (auto) return `auto:${auto}`;
    if (el.name) {
      // Include type so radio groups don't collide across types; still stable
      const type = (el.getAttribute("type") || el.tagName).toLowerCase();
      // For radios, include value so each option is distinct and stable
      if (type === "radio" && el.value) return `name:${el.name}:radio:${el.value}`;
      return `name:${el.name}`;
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.length < 80) return `aria:${aria.slice(0, 60)}`;
    // Last resort: path (may shift if DOM reorders) + light index for uniqueness
    return `path:${cssPath(el)}#${index}`;
  }

  function labelFor(el) {
    const bits = [];
    if (el.id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) bits.push((lab.innerText || lab.textContent || "").trim());
      } catch {
        /* */
      }
    }
    const wrapped = el.closest("label");
    if (wrapped) bits.push((wrapped.innerText || wrapped.textContent || "").trim());

    const aria = el.getAttribute("aria-label");
    if (aria) bits.push(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const n = document.getElementById(id);
        if (n) bits.push((n.innerText || n.textContent || "").trim());
      }
    }
    const describedBy = el.getAttribute("aria-describedby");
    if (describedBy) {
      for (const id of describedBy.split(/\s+/)) {
        const n = document.getElementById(id);
        if (n) bits.push((n.innerText || n.textContent || "").trim());
      }
    }

    const fs = el.closest("fieldset");
    if (fs) {
      const leg = fs.querySelector("legend");
      if (leg) bits.push((leg.innerText || "").trim());
    }

    // Workday / Greenhouse style: sibling or parent label nodes
    let prev = el.previousElementSibling;
    let hops = 0;
    while (prev && hops < 3) {
      if (prev.matches("label, span, div, p, strong, b, h1, h2, h3, h4, legend")) {
        const t = (prev.innerText || "").trim();
        if (t && t.length < 120) {
          bits.push(t);
          break;
        }
      }
      prev = prev.previousElementSibling;
      hops++;
    }

    const row = el.closest(
      ".form-group, .field, .form-field, .application-field, " +
        "[class*='FormField'], [class*='form-field'], [class*='FormRow'], " +
        "[data-field], [data-automation-id], .select__container, " +
        "[class*='input-wrapper'], [class*='InputWrapper']"
    );
    if (row) {
      const lab = row.querySelector(
        "label, .label, [class*='label'], [class*='Label'], legend"
      );
      if (lab && !lab.contains(el)) {
        const t = (lab.innerText || "").trim();
        if (t.length < 120) bits.push(t);
      }
    }

    // Section heading above multi-row experience blocks
    const section = el.closest(
      "section, [class*='experience'], [class*='education'], [class*='Experience'], [class*='Education']"
    );
    if (section) {
      const h = section.querySelector("h1, h2, h3, h4, [class*='heading'], [class*='Heading']");
      if (h) {
        const t = (h.innerText || "").trim();
        if (t && t.length < 80) bits.push(t);
      }
    }

    const seen = new Set();
    const clean = [];
    for (const b of bits) {
      const s = b.replace(/\s+/g, " ").trim();
      if (!s || s.length > 200) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      clean.push(s);
    }
    return clean.join(" | ");
  }

  function isVisible(el) {
    if (el.disabled) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  }

  function fieldType(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true")
      return "contenteditable";
    if (el.getAttribute("role") === "textbox") return "textbox";
    if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox")
      return "combobox";
    if (el.getAttribute("role") === "listbox") return "listbox";
    return (el.getAttribute("type") || "text").toLowerCase();
  }

  function optionsOf(el) {
    if (el.tagName.toLowerCase() === "select") {
      return [...el.options].map((o) => ({
        value: o.value,
        text: (o.textContent || "").trim(),
      }));
    }
    // ARIA listbox options (best-effort)
    if (el.getAttribute("role") === "listbox" || el.getAttribute("role") === "combobox") {
      const opts = el.querySelectorAll('[role="option"]');
      if (opts.length) {
        return [...opts].map((o) => ({
          value: o.getAttribute("data-value") || (o.innerText || "").trim(),
          text: (o.innerText || "").trim(),
        }));
      }
    }
    return null;
  }

  /**
   * @returns {{ fields: object[], pageUrl: string, formCount: number }}
   */
  function scanForms() {
    const candidates = [
      ...document.querySelectorAll(
        "input, select, textarea, " +
          "[contenteditable='true'], [contenteditable=''], " +
          "[role='textbox'], [role='combobox'], [role='searchbox']"
      ),
    ];
    const fields = [];
    let index = 0;
    const usedIds = new Set();

    for (const el of candidates) {
      const type = fieldType(el);
      if (SKIP_TYPES.has(type)) continue;
      if (!isVisible(el) && type !== "checkbox" && type !== "radio") continue;

      if (el.closest("nav, [role='search'], header")) {
        const name = (el.name || el.id || "").toLowerCase();
        if (name.includes("search") || type === "search") continue;
      }

      let id = stableId(el, index++);
      // Ensure uniqueness if two path-based collide
      if (usedIds.has(id)) id = `${id}~${index}`;
      usedIds.add(id);
      el.setAttribute("data-jobapply-id", id);

      fields.push({
        id,
        tag: el.tagName.toLowerCase(),
        type,
        name: el.name || "",
        label: labelFor(el),
        placeholder: el.getAttribute("placeholder") || "",
        autocomplete: el.getAttribute("autocomplete") || "",
        required: el.required || el.getAttribute("aria-required") === "true",
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        options: optionsOf(el),
        value: type === "checkbox" || type === "radio" ? el.checked : el.value || "",
      });
    }

    return {
      fields,
      pageUrl: location.href,
      formCount: document.forms.length,
      scannedAt: new Date().toISOString(),
    };
  }

  function findByJobApplyId(id) {
    return document.querySelector(`[data-jobapply-id="${CSS.escape(id)}"]`);
  }

  global.JobApplyFormScanner = { scanForms, findByJobApplyId, stableId };
})(typeof globalThis !== "undefined" ? globalThis : window);
