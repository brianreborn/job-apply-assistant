/**
 * Fill form fields from a map of { id, value }. Never submits.
 * Supports native inputs, selects, contenteditable, and light SPA combobox patterns.
 */
(function (global) {
  "use strict";

  function setNativeValue(el, value) {
    const tag = el.tagName.toLowerCase();
    const proto =
      tag === "textarea"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fire(el, type, opts = {}) {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...opts }));
  }

  function fireInput(el) {
    try {
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: true, data: el.value })
      );
    } catch {
      fire(el, "input");
    }
    fire(el, "change");
    // React 17+ often listens on the element tracker; also fire keyup for maskers
    fire(el, "keyup");
    fire(el, "blur");
  }

  const STATE_MAP = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
    CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
    KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
    MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
    NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
    OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
    SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
    VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
    DC: "District of Columbia"
  };
  const STATE_REVERSE = Object.fromEntries(
    Object.entries(STATE_MAP).map(([k, v]) => [v.toLowerCase(), k])
  );

  function fillSelect(el, value) {
    const v = String(value).trim();
    let opt = [...el.options].find((o) => o.value === v);
    if (!opt) {
      const lower = v.toLowerCase();
      opt = [...el.options].find(
        (o) =>
          (o.textContent || "").trim().toLowerCase() === lower ||
          (o.textContent || "").trim().toLowerCase().includes(lower) ||
          o.value.toLowerCase() === lower
      );
    }
    // State abbreviation check: e.g. "CA" <-> "California"
    if (!opt) {
      const upper = v.toUpperCase();
      const altName = STATE_MAP[upper] || STATE_REVERSE[v.toLowerCase()];
      if (altName) {
        const altLower = altName.toLowerCase();
        opt = [...el.options].find(
          (o) =>
            o.value.toUpperCase() === altName.toUpperCase() ||
            (o.textContent || "").trim().toLowerCase() === altLower ||
            (o.textContent || "").trim().toLowerCase().includes(altLower)
        );
      }
    }
    // Fuzzy: first word match for country/state lists
    if (!opt && v.length > 2) {
      const lower = v.toLowerCase();
      opt = [...el.options].find((o) =>
        (o.textContent || "").trim().toLowerCase().startsWith(lower)
      );
    }
    if (!opt) return false;
    el.value = opt.value;
    fire(el, "input");
    fire(el, "change");
    return true;
  }

  function fillCheckboxOrRadio(el, value) {
    if (el.type === "radio") {
      const want = String(value).toLowerCase();
      if (
        el.value?.toLowerCase() === want ||
        (el.labels?.[0]?.innerText || "").trim().toLowerCase() === want ||
        (el.labels?.[0]?.innerText || "").trim().toLowerCase().includes(want)
      ) {
        el.checked = true;
        fire(el, "input");
        fire(el, "change");
        return true;
      }
      return false;
    }
    const truthy =
      value === true ||
      value === "true" ||
      value === "1" ||
      value === "yes" ||
      value === "on" ||
      String(value).toLowerCase() === el.value?.toLowerCase();
    el.checked = Boolean(truthy);
    fire(el, "input");
    fire(el, "change");
    return true;
  }

  function fillContentEditable(el, value) {
    el.focus();
    // Prefer execCommand for broader SPA compatibility; fall back to textContent
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand("insertText", false, String(value));
      if (!ok) {
        el.textContent = String(value);
      }
    } catch {
      el.textContent = String(value);
    }
    fire(el, "input");
    fire(el, "change");
    return true;
  }

  /**
   * Greenhouse / Lever style custom selects: often a button + hidden input,
   * or combobox with listbox. Best-effort: set nearby hidden input + type into open field.
   */
  function fillCombobox(el, value) {
    el.focus();
    setNativeValue(el, String(value));
    fireInput(el);
    // Try to open and pick matching option
    try {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })
      );
      const root = el.closest("[class*='select'], [class*='Select'], [role='combobox']") || document;
      const opts = root.querySelectorAll('[role="option"], [class*="option"], li');
      const want = String(value).toLowerCase();
      for (const o of opts) {
        const t = (o.innerText || o.textContent || "").trim().toLowerCase();
        if (t === want || t.includes(want)) {
          o.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        }
      }
      // Escape open list
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    } catch {
      /* */
    }
    return true;
  }

  function fillOne(el, value) {
    if (value == null || value === "") return { ok: false, reason: "empty" };
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const role = el.getAttribute("role") || "";

    if (tag === "select") {
      return fillSelect(el, value) ? { ok: true } : { ok: false, reason: "no-option" };
    }
    if (type === "checkbox" || type === "radio") {
      return fillCheckboxOrRadio(el, value)
        ? { ok: true }
        : { ok: false, reason: "checkbox-mismatch" };
    }
    if (
      el.isContentEditable ||
      el.getAttribute("contenteditable") === "true" ||
      role === "textbox"
    ) {
      fillContentEditable(el, value);
      return { ok: true };
    }
    if (role === "combobox" || el.getAttribute("aria-haspopup") === "listbox") {
      fillCombobox(el, value);
      return { ok: true };
    }

    if (type === "month") {
      let str = String(value).trim();
      const mMonth = str.match(/(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*|\b(\d{1,2}))[\s\/-]+(\d{4})\b/i) ||
                     str.match(/\b(\d{4})[\s\/-]+(\d{1,2})\b/);
      if (mMonth) {
        let yr = mMonth[3] || mMonth[1];
        let mo = mMonth[1] || mMonth[2];
        if (mMonth[1] && isNaN(mo)) {
          const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
          mo = String(MONTHS.indexOf(mMonth[1].toLowerCase().slice(0,3)) + 1).padStart(2, "0");
        } else {
          mo = String(mo).padStart(2, "0");
        }
        str = `${yr}-${mo}`;
      }
      setNativeValue(el, str);
      fireInput(el);
      return { ok: true };
    }
    if (type === "date") {
      let str = String(value).trim();
      const mDate = str.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/) ||
                    str.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
      if (mDate) {
        if (mDate[1].length === 4) {
          str = `${mDate[1]}-${String(mDate[2]).padStart(2, "0")}-${String(mDate[3]).padStart(2, "0")}`;
        } else {
          str = `${mDate[3]}-${String(mDate[1]).padStart(2, "0")}-${String(mDate[2]).padStart(2, "0")}`;
        }
      }
      setNativeValue(el, str);
      fireInput(el);
      return { ok: true };
    }

    el.focus();
    // Respect maxlength when present
    let str = String(value);
    if (el.maxLength > 0 && str.length > el.maxLength) {
      str = str.slice(0, el.maxLength);
    }
    setNativeValue(el, str);
    fireInput(el);

    // Some frameworks only pick up value via InputEvent on the tracker property
    try {
      const tracker = el._valueTracker;
      if (tracker) tracker.setValue("");
      setNativeValue(el, str);
      fireInput(el);
    } catch {
      /* */
    }

    return { ok: true };
  }

  function resolveElement(itemId) {
    // Prefer stamped attribute from last scan
    let el = document.querySelector(`[data-jobapply-id="${CSS.escape(itemId)}"]`);
    if (el) return el;

    if (itemId.startsWith("id:")) {
      el = document.getElementById(itemId.slice(3));
      if (el) return el;
    }
    if (itemId.startsWith("name:")) {
      const rest = itemId.slice(5);
      // name:foo or name:foo:radio:bar
      const radioM = rest.match(/^(.+):radio:(.+)$/);
      if (radioM) {
        el = document.querySelector(
          `input[type="radio"][name="${CSS.escape(radioM[1])}"][value="${CSS.escape(radioM[2])}"]`
        );
        if (el) return el;
      }
      el = document.querySelector(`[name="${CSS.escape(rest)}"]`);
      if (el) return el;
    }
    if (itemId.startsWith("auto:")) {
      const v = itemId.slice(5);
      el =
        document.querySelector(`[data-automation-id="${CSS.escape(v)}"]`) ||
        document.querySelector(`[data-testid="${CSS.escape(v)}"]`) ||
        document.querySelector(`[data-qa="${CSS.escape(v)}"]`) ||
        document.querySelector(`[data-field="${CSS.escape(v)}"]`);
      if (el) return el;
    }
    if (itemId.startsWith("aria:")) {
      const v = itemId.slice(5);
      el = document.querySelector(`[aria-label="${CSS.escape(v)}"]`);
      if (el) return el;
    }
    return null;
  }

  /**
   * @param {{ id: string, value: any }[]} fills
   */
  function fillFields(fills) {
    document.documentElement.setAttribute("data-jobapply-fill-active", "1");
    document.documentElement.setAttribute(
      "data-jobapply-fill-at",
      new Date().toISOString()
    );
    document.documentElement.removeAttribute("data-jobapply-submit-warned");

    const results = [];
    let filled = 0;
    let skipped = 0;
    let missing = 0;

    for (const item of fills || []) {
      const el = resolveElement(item.id);

      if (!el) {
        missing++;
        results.push({ id: item.id, status: "not-found" });
        continue;
      }
      if (item.value == null || item.value === "") {
        skipped++;
        results.push({ id: item.id, status: "skipped-empty" });
        continue;
      }

      try {
        const r = fillOne(el, item.value);
        if (r.ok) {
          filled++;
          results.push({ id: item.id, status: "filled" });
        } else {
          skipped++;
          results.push({ id: item.id, status: r.reason || "failed" });
        }
      } catch (err) {
        skipped++;
        results.push({ id: item.id, status: "error", error: String(err.message || err) });
      }
    }

    setTimeout(() => {
      document.documentElement.removeAttribute("data-jobapply-fill-active");
    }, 10 * 60 * 1000);

    return {
      filled,
      skipped,
      missing,
      total: (fills || []).length,
      results,
      neverSubmit: true,
      message:
        "Fields filled where possible. Review and submit manually — never auto-submitted.",
    };
  }

  global.JobApplyFormFiller = { fillFields };
})(typeof globalThis !== "undefined" ? globalThis : window);
