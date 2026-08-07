(function () {
  "use strict";
  const Api = window.JobApplyApi;
  const $ = (id) => document.getElementById(id);

  function show(el, on) {
    el.classList.toggle("hidden", !on);
  }
  function banner(text, kind = "info") {
    const el = $("banner");
    if (!text) {
      show(el, false);
      return;
    }
    el.className = `banner ${kind}`;
    el.textContent = text;
    show(el, true);
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  async function refreshVault() {
    const st = await Api.sessionStatus();
    const b = $("vaultBadge");
    if (!st.setup) {
      b.textContent = "not set up";
      b.className = "badge warn";
      show($("needUnlock"), false);
      show($("opts"), false);
      banner("Open the sidebar first to create a vault passphrase.", "warn");
      return st;
    }
    if (!st.unlocked) {
      b.textContent = "locked";
      b.className = "badge danger";
      show($("needUnlock"), true);
      show($("opts"), false);
      return st;
    }
    b.textContent = "unlocked";
    b.className = "badge ok";
    show($("needUnlock"), false);
    show($("opts"), true);
    return st;
  }

  async function loadSettings() {
    const s = await Api.getSettings();
    $("keyBadge").textContent = s.hasXaiKey ? "key set" : "no key";
    $("keyBadge").className = s.hasXaiKey ? "badge ok" : "badge warn";
    $("openaiKeyBadge").textContent = s.hasOpenaiKey ? "key set" : "no key";
    $("openaiKeyBadge").className = s.hasOpenaiKey ? "badge ok" : "badge warn";
    $("model").value = s.model || "grok-3";
    // If model not in list, add it
    if (![...$("model").options].some((o) => o.value === s.model) && s.model) {
      const opt = document.createElement("option");
      opt.value = s.model;
      opt.textContent = s.model;
      $("model").appendChild(opt);
      $("model").value = s.model;
    }
    const om = s.openaiModel || "gpt-4o-mini";
    $("openaiModel").value = om;
    if (![...$("openaiModel").options].some((o) => o.value === om) && om) {
      const opt = document.createElement("option");
      opt.value = om;
      opt.textContent = om;
      $("openaiModel").appendChild(opt);
      $("openaiModel").value = om;
    }
    $("geminiKeyBadge").textContent = s.hasGeminiKey ? "key set" : "no key";
    $("geminiKeyBadge").className = s.hasGeminiKey ? "badge ok" : "badge warn";
    const gm = s.geminiModel || "gemini-2.0-flash";
    $("geminiModel").value = gm;
    if (![...$("geminiModel").options].some((o) => o.value === gm) && gm) {
      const opt = document.createElement("option");
      opt.value = gm;
      opt.textContent = gm;
      $("geminiModel").appendChild(opt);
      $("geminiModel").value = gm;
    }
    $("msKeyBadge").textContent = s.hasMsKey ? "key set" : "no key";
    $("msKeyBadge").className = s.hasMsKey ? "badge ok" : "badge warn";
    const mm = s.msModel || "gpt-4o-mini";
    $("msModel").value = mm;
    if (![...$("msModel").options].some((o) => o.value === mm) && mm) {
      const opt = document.createElement("option");
      opt.value = mm;
      opt.textContent = mm;
      $("msModel").appendChild(opt);
      $("msModel").value = mm;
    }
    $("msEndpoint").value = s.msEndpoint || "";
    $("combinePrompts").checked = s.combinePrompts !== false;
    $("googleClientId").value = s.googleClientId || "";
    $("auditDays").value = s.auditRetentionDays ?? 90;
    $("redirectUrl").textContent = "redirect: " + browser.identity.getRedirectURL();

    const g = await Api.googleStatus();
    if (g.connected || g.sessionLoggedIn) {
      const mode = g.mode === "oauth" ? "oauth" : "session";
      $("googleBadge").textContent = g.sessionEmail
        ? `${mode}: ${g.sessionEmail}`
        : `${mode} ready`;
      $("googleBadge").className = "badge ok";
    } else if (g.needsSignIn) {
      $("googleBadge").textContent = "sign in to Google in Firefox";
      $("googleBadge").className = "badge warn";
    } else {
      $("googleBadge").textContent = "disconnected";
      $("googleBadge").className = "badge";
    }

    const p = (await Api.getProfile()) || {};
    const PROFILE_KEYS = [
      "fullName", "email", "phone", "location", "linkedin",
      "github", "website", "city", "state", "zip", "country", "address"
    ];
    for (const k of PROFILE_KEYS) {
      const el = $(`pf_${k}`);
      if (el) el.value = p[k] || "";
    }
  }

  async function loadAccounts() {
    const list = await Api.listAccounts();
    const ul = $("accountList");
    ul.innerHTML = "";
    if (!list.length) {
      ul.innerHTML = "<li class='muted'>No accounts — import browser sessions or add manually.</li>";
      return;
    }
    for (const a of list) {
      const li = document.createElement("li");
      const left = document.createElement("div");
      const uname = a.username ? `@${a.username}` : "(username unresolved)";
      const keyedOk = a.username && String(a.id || "").toLowerCase() === `x:${String(a.username).toLowerCase()}`;
      left.innerHTML = `<strong>${escapeHtml(uname)}</strong>
        ${keyedOk ? `<span class="badge ok" style="margin-left:6px">unique key</span>` : a.username ? `<span class="badge warn" style="margin-left:6px">rekey needed</span>` : `<span class="badge warn" style="margin-left:6px">no @user</span>`}
        ${a.label && a.label !== uname ? `<span class="muted small"> · ${escapeHtml(a.label)}</span>` : ""}
        <div class="muted small mono">id ${escapeHtml(a.id)}
        · used ${escapeHtml(a.lastUsedAt || "never")}
        · ok ${a.stats?.ok || 0} / fail ${a.stats?.fail || 0}</div>
        ${a.lastError ? `<div class="small" style="color:var(--danger)">${escapeHtml(a.lastError)}</div>` : ""}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sm danger";
      btn.textContent = "Remove";
      btn.addEventListener("click", async () => {
        if (!confirm(`Remove account “${a.username || a.label}”?`)) return;
        await Api.removeAccount(a.id);
        banner("Account removed.", "ok");
        await loadAccounts();
      });
      li.appendChild(left);
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  async function loadAudit() {
    const channel = $("auditChannel").value || null;
    const rows = await Api.auditList({ limit: 150, channel: channel || undefined });
    const body = $("auditBody");
    body.innerHTML = "";
    for (const r of rows || []) {
      const tr = document.createElement("tr");
      const st = r.responseMeta?.status ?? "";
      const note = r.error || r.note || "";
      tr.innerHTML = `<td>${escapeHtml((r.ts || "").replace("T", " ").slice(0, 19))}</td>
        <td>${escapeHtml(r.channel || "")}</td>
        <td>${escapeHtml(r.purpose || "")}</td>
        <td>${escapeHtml(r.method || "")}</td>
        <td>${escapeHtml(String(st))}</td>
        <td>${escapeHtml(String(note).slice(0, 120))}</td>`;
      body.appendChild(tr);
    }
  }

  $("btnUnlock").addEventListener("click", async () => {
    try {
      await Api.unlock($("unlockPass").value);
      $("unlockPass").value = "";
      banner("Unlocked.", "ok");
      await refreshVault();
      await loadAll();
    } catch (e) {
      banner(e.message, "danger");
    }
  });

  $("btnSaveKey").addEventListener("click", async () => {
    try {
      const key = $("xaiKey").value.trim();
      if (!key) throw new Error("Enter a key or use Clear");
      await Api.setXaiKey(key);
      $("xaiKey").value = "";
      banner("xAI API key saved encrypted.", "ok");
      await loadSettings();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnClearKey").addEventListener("click", async () => {
    try {
      await Api.setXaiKey("");
      banner("xAI API key cleared.", "ok");
      await loadSettings();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnSaveOpenaiKey").addEventListener("click", async () => {
    try {
      const key = $("openaiKey").value.trim();
      if (!key) throw new Error("Enter a key or use Clear");
      await Api.setOpenaiKey(key);
      $("openaiKey").value = "";
      banner("OpenAI API key saved encrypted. It will be used automatically if Grok fails.", "ok");
      await loadSettings();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnClearOpenaiKey").addEventListener("click", async () => {
    try {
      await Api.setOpenaiKey("");
      banner("OpenAI API key cleared.", "ok");
      await loadSettings();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnSaveModel").addEventListener("click", async () => {
    try {
      await Api.setSettings({
        model: $("model").value,
        combinePrompts: $("combinePrompts").checked,
      });
      banner("Grok model settings saved.", "ok");
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnSaveOpenaiModel").addEventListener("click", async () => {
    try {
      await Api.setSettings({
        openaiModel: $("openaiModel").value,
      });
      banner("OpenAI model saved.", "ok");
    } catch (e) {
      banner(e.message, "danger");
    }
  });

  $("btnSaveGeminiKey").addEventListener("click", async () => {
    try {
      const key = $("geminiKey").value.trim();
      if (!key) throw new Error("Enter a key or use Clear");
      await Api.setGeminiKey(key);
      $("geminiKey").value = "";
      banner("Google Gemini API key saved encrypted.", "ok");
      await loadSettings();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnClearGeminiKey").addEventListener("click", async () => {
    try {
      await Api.setGeminiKey("");
      banner("Google Gemini API key cleared.", "ok");
      await loadSettings();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnSaveGeminiModel").addEventListener("click", async () => {
    try {
      await Api.setSettings({
        geminiModel: $("geminiModel").value,
      });
      banner("Gemini model saved.", "ok");
    } catch (e) {
      banner(e.message, "danger");
    }
  });

  $("btnSaveMsKey").addEventListener("click", async () => {
    try {
      const key = $("msKey").value.trim();
      if (!key) throw new Error("Enter a key or use Clear");
      const endpoint = $("msEndpoint").value.trim();
      await Api.setMsKey(key, endpoint);
      $("msKey").value = "";
      banner("Microsoft / GitHub Models API key saved encrypted.", "ok");
      await loadSettings();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnClearMsKey").addEventListener("click", async () => {
    try {
      await Api.setMsKey("", "");
      banner("Microsoft API key cleared.", "ok");
      await loadSettings();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnSaveMsModel").addEventListener("click", async () => {
    try {
      await Api.setSettings({
        msModel: $("msModel").value,
        msEndpoint: $("msEndpoint").value.trim(),
      });
      banner("Microsoft / GitHub model settings saved.", "ok");
    } catch (e) {
      banner(e.message, "danger");
    }
  });

  $("btnImportX").addEventListener("click", async () => {
    try {
      const r = await Api.importBrowserX();
      const n = r.added?.length || 0;
      const u = r.updated?.length || 0;
      const d = r.deduped || 0;
      banner(
        `X import: ${n} new, ${u} updated (found ${r.totalFound} session(s))` +
          (d ? `; collapsed ${d} duplicate(s)` : "") +
          `. Keyed uniquely by @username.`,
        "ok"
      );
      await loadAccounts();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnRefreshAccounts").addEventListener("click", () => loadAccounts());
  $("btnRekeyAccounts")?.addEventListener("click", async () => {
    try {
      const r = await Api.rekeyAccounts();
      banner(
        `Rekeyed ${r.rekeyed || 0} account(s), removed ${r.deduped || 0} duplicate(s). Pool is unique by @username.`,
        "ok"
      );
      await loadAccounts();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnAddAccount").addEventListener("click", async () => {
    try {
      const row = await Api.addAccount({
        label: $("accLabel").value || undefined,
        authToken: $("accAuth").value.trim(),
        ct0: $("accCt0").value.trim(),
        userAgent: $("accUa").value.trim() || undefined,
      });
      $("accAuth").value = "";
      $("accCt0").value = "";
      const key = row?.username ? `@${row.username}` : row?.id || "account";
      banner(
        row?._upsert === "updated"
          ? `Updated existing ${key} (unique by username).`
          : `Added ${key} (unique by username).`,
        "ok"
      );
      await loadAccounts();
    } catch (e) {
      banner(e.message, "danger");
    }
  });

  $("btnSaveGoogleClient").addEventListener("click", async () => {
    try {
      await Api.setGoogleClient($("googleClientId").value.trim());
      banner("Google client id saved.", "ok");
      await loadSettings();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnGoogleConnect").addEventListener("click", async () => {
    try {
      const res = await Api.googleConnect();
      banner(
        res?.message || "Google enabled (read-only browser session or OAuth).",
        "ok"
      );
      await loadSettings();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnGoogleDisconnect").addEventListener("click", async () => {
    try {
      await Api.googleDisconnect();
      banner("Google disconnected.", "ok");
      await loadSettings();
    } catch (e) {
      banner(e.message, "danger");
    }
  });

  $("btnSaveProfile").addEventListener("click", async () => {
    try {
      const PROFILE_KEYS = [
        "fullName", "email", "phone", "location", "linkedin",
        "github", "website", "city", "state", "zip", "country", "address"
      ];
      const profile = {};
      for (const k of PROFILE_KEYS) {
        const el = $(`pf_${k}`);
        profile[k] = el?.value?.trim() || "";
      }
      const saved = await Api.setProfile(profile);
      const vals = Object.values(saved || {}).filter(Boolean);
      if (vals.length) await Api.approvePii(vals.map((v) => ({ value: v, type: "profile" })));
      banner("Profile saved.", "ok");
    } catch (e) {
      banner(e.message, "danger");
    }
  });

  $("auditChannel").addEventListener("change", () => loadAudit());
  $("btnAuditRefresh").addEventListener("click", () => loadAudit());
  $("btnAuditExport").addEventListener("click", async () => {
    try {
      const text = await Api.auditExport({ limit: 5000 });
      const blob = new Blob([text || ""], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `jobapply-audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
      banner("Export downloaded.", "ok");
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnAuditClear").addEventListener("click", async () => {
    if (!confirm("Clear entire audit log?")) return;
    try {
      await Api.auditClear();
      banner("Audit cleared.", "ok");
      await loadAudit();
    } catch (e) {
      banner(e.message, "danger");
    }
  });
  $("btnSaveRetention").addEventListener("click", async () => {
    try {
      await Api.setSettings({ auditRetentionDays: Number($("auditDays").value) || 0 });
      banner("Retention saved.", "ok");
    } catch (e) {
      banner(e.message, "danger");
    }
  });

  $("btnLock").addEventListener("click", async () => {
    await Api.lock();
    banner("Locked.", "info");
    await refreshVault();
  });

  async function loadAll() {
    await loadSettings();
    await loadAccounts();
    await loadAudit();
  }

  browser.runtime.onMessage.addListener((m) => {
    if (m?.type === "event") {
      if (m.event === "session.changed") {
        refreshVault()
          .then((st) => (st.unlocked ? loadAll() : null))
          .catch((e) => banner(e.message, "danger"));
      } else if (m.event === "application.changed") {
        loadAudit().catch(() => {});
      }
    }
  });

  refreshVault()
    .then((st) => (st.unlocked ? loadAll() : null))
    .catch((e) => banner(e.message, "danger"));
})();
