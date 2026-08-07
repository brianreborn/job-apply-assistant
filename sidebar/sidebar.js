/**
 * Sidebar workflow for JobApply Assistant.
 */
(function () {
  "use strict";

  const Api = window.JobApplyApi;
  const $ = (id) => document.getElementById(id);

  const PROFILE_KEYS = [
    "fullName",
    "email",
    "phone",
    "location",
    "linkedin",
    "github",
    "website",
    "city",
    "state",
    "country",
    "address",
    "zip",
  ];

  function show(el, on = true) {
    if (!el) return;
    el.classList.toggle("hidden", !on);
  }

  function setBanner(id, text, kind) {
    const el = $(id);
    if (!el) return;
    if (!text) {
      show(el, false);
      el.textContent = "";
      return;
    }
    el.className = `banner ${kind || "info"}`;
    el.textContent = text;
    show(el, true);
  }

  function setError(err) {
    if (!err) {
      setBanner("errorBanner", "", "danger");
      return;
    }
    let msg = err.message || String(err);
    if (err.code === "NEED_MORE_ACCOUNTS" || err.code === "X_SESSION_UNAVAILABLE") {
      msg +=
        " Open Options → add a free Google Gemini key, Microsoft/GitHub Models key, OpenAI key, xAI key, or X accounts.";
    }
    if (err.code === "LOCKED") {
      msg = "Vault locked — unlock first.";
    }
    setBanner("errorBanner", msg, "danger");
  }

  function setStatus(text, kind = "info") {
    setBanner("statusBanner", text, kind);
  }

  async function refreshVaultUi() {
    const st = await Api.sessionStatus();
    const badge = $("vaultBadge");
    show($("vaultSetup"), !st.setup);
    show($("vaultUnlock"), st.setup && !st.unlocked);
    show($("vaultOpen"), st.unlocked);
    show($("mainApp"), st.unlocked);
    if (!st.setup) {
      badge.textContent = "setup";
      badge.className = "badge warn";
    } else if (!st.unlocked) {
      badge.textContent = "locked";
      badge.className = "badge danger";
    } else {
      badge.textContent = "unlocked";
      badge.className = "badge ok";
    }
    return st;
  }

  async function loadCvUi() {
    const cv = await Api.getCv();
    if (cv?.text) {
      $("cvText").value = cv.text;
      $("cvMeta").textContent = `${cv.source || "cv"} · ${(cv.text || "").length} chars`;
      $("cvMeta").className = "badge ok";
    } else {
      $("cvMeta").textContent = "none";
      $("cvMeta").className = "badge";
    }
  }

  async function loadProfileUi() {
    const p = (await Api.getProfile()) || {};
    for (const k of PROFILE_KEYS) {
      const el = $(`pf_${k}`);
      if (el) el.value = p[k] || "";
    }
  }

  async function loadAppUi() {
    const app = await Api.getApplication();
    if (!app) return;
    $("jobTitle").value = app.jobTitle || "";
    $("jobCompany").value = app.company || "";
    $("jdText").value = app.jobDescription || "";
    $("coverLetter").value = app.coverLetter || "";
    if ($("atsResumeText")) $("atsResumeText").value = app.atsResumeText || "";
    $("appStatus").textContent = app.status || "—";
    $("appStatus").className =
      app.status === "analyzed"
        ? "badge ok"
        : app.status === "analyze_partial"
          ? "badge warn"
          : "badge info";

    const emp = $("emphasisList");
    emp.innerHTML = "";
    for (const e of app.emphasisPoints || []) {
      const li = document.createElement("li");
      li.textContent = e;
      emp.appendChild(li);
    }

    if ($("distilledObjective")) {
      $("distilledObjective").textContent =
        app.distilled?.objective || "—";
    }
    $("distilledSummary").textContent = app.distilled?.summary || "—";
    $("atsNotes").textContent = app.ats?.atsNotes || "—";
    const hits = (app.ats?.keywordHits || app.distilled?.keywords || []).join(", ");
    const gaps = (app.ats?.missingKeywords || app.distilled?.gaps || []).join(", ");
    $("atsKeywords").textContent = `Hits: ${hits || "—"}\nGaps: ${gaps || "—"}`;

    const exp = app.distilled?.experience || [];
    $("expList").textContent = exp.length
      ? exp
          .map(
            (j, i) =>
              `[${i + 1}] ${j.title || "?"} @ ${j.employer || "?"} (${j.start || "?"} – ${j.end || "?"})\n${
                j.bullets?.join("\n") || j.description || ""
              }`
          )
          .join("\n\n")
      : "—";

    renderFieldMap(app.fieldMap || []);
  }

  function renderFieldMap(map) {
    const body = $("fieldMapBody");
    body.innerHTML = "";
    for (const m of map) {
      const tr = document.createElement("tr");
      const val = m.value == null || m.value === "" ? "—" : String(m.value).slice(0, 80);
      tr.innerHTML = `<td>${escapeHtml(m.label || m.id)}</td><td class="mono">${escapeHtml(
        val
      )}</td><td>${escapeHtml(m.source || "")}</td>`;
      body.appendChild(tr);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function refreshGoogle() {
    try {
      const st = await Api.googleStatus();
      const b = $("googleBadge");
      if (st.connected || st.sessionLoggedIn) {
        const mode = st.mode === "oauth" ? "oauth" : "session";
        b.textContent = st.sessionEmail ? `${mode}: ${st.sessionEmail}` : mode;
        b.className = "badge ok";
      } else if (st.needsSignIn) {
        b.textContent = "sign in to Google";
        b.className = "badge warn";
      } else {
        b.textContent = "disconnected";
        b.className = "badge";
      }
    } catch {
      $("googleBadge").textContent = "—";
    }
  }

  async function refreshAudit() {
    try {
      const channel = $("auditFilter")?.value || null;
      const rows = await Api.auditList({
        limit: 40,
        channel: channel || undefined,
      });
      const body = $("auditBody");
      body.innerHTML = "";
      for (const r of rows || []) {
        const tr = document.createElement("tr");
        const t = (r.ts || "").slice(11, 19);
        const st = r.responseMeta?.status ?? (r.error ? "err" : "ok");
        const purpose = r.purpose || "";
        tr.title = [r.url, r.note, r.error, r.requestMeta?.initiator]
          .filter(Boolean)
          .join(" · ");
        tr.innerHTML = `<td>${escapeHtml(t)}</td><td>${escapeHtml(
          r.channel || ""
        )}</td><td>${escapeHtml(purpose)}</td><td>${escapeHtml(String(st))}</td>`;
        body.appendChild(tr);
      }
    } catch {
      /* vault locked */
    }
  }

  function showPiiReview(unvetted) {
    const el = $("piiBanner");
    if (!unvetted?.length) {
      show(el, false);
      return;
    }
    el.className = "banner warn";
    el.innerHTML = "";
    const title = document.createElement("div");
    title.innerHTML =
      "<strong>PII review required</strong> — approve values to send with Grok prompts (or save them in profile).";
    el.appendChild(title);
    const list = document.createElement("ul");
    list.className = "list";
    const checks = [];
    for (const u of unvetted) {
      const li = document.createElement("li");
      const lab = document.createElement("label");
      lab.style.display = "flex";
      lab.style.gap = "8px";
      lab.style.alignItems = "center";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.value = u.value;
      cb.dataset.type = u.type;
      checks.push(cb);
      lab.appendChild(cb);
      const span = document.createElement("span");
      span.className = "mono";
      span.textContent = `${u.type}: ${u.value}`;
      lab.appendChild(span);
      li.appendChild(lab);
      list.appendChild(li);
    }
    el.appendChild(list);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "primary sm";
    btn.textContent = "Approve selected & retry analyze";
    btn.style.marginTop = "8px";
    btn.addEventListener("click", async () => {
      try {
        const values = checks
          .filter((c) => c.checked)
          .map((c) => ({ value: c.dataset.value, type: c.dataset.type }));
        await Api.approvePii(values);
        show(el, false);
        setStatus("PII approved. Retrying analyze…", "ok");
        await runAnalyze();
      } catch (err) {
        setError(err);
      }
    });
    el.appendChild(btn);
    show(el, true);
  }

  /**
   * Persist unsaved sidebar fields so Analyze / Map / Fill use what the user sees.
   * High-impact for live validation: pasting then clicking Analyze without Save.
   */
  async function persistDraftInputs({ requireCv = false, requireJd = false } = {}) {
    const cvText = $("cvText")?.value || "";
    const existingCv = await Api.getCv().catch(() => null);
    if (cvText.trim()) {
      const same = existingCv?.text && existingCv.text === cvText;
      if (!same) {
        await Api.setCvText(cvText, {
          source: existingCv?.source || "paste",
          name: existingCv?.name || "pasted-cv",
        });
      }
    } else if (requireCv && !existingCv?.text) {
      throw new Error("Paste or import a CV first, then run Analyze.");
    }

    const jdText = $("jdText")?.value || "";
    const jobTitle = $("jobTitle")?.value || "";
    const jobCompany = $("jobCompany")?.value || "";
    if (jdText.trim() || jobTitle.trim() || jobCompany.trim()) {
      await Api.setJdText({
        text: jdText,
        jobTitle,
        company: jobCompany,
      });
    } else if (requireJd) {
      const app = await Api.getApplication().catch(() => null);
      if (!app?.jobDescription?.trim()) {
        throw new Error("Capture or paste a job description first.");
      }
    }

    // Keep Results edits in the draft used by Map/Fill
    const cover = $("coverLetter")?.value;
    if (cover != null && cover !== "") {
      try {
        await Api.saveCover(cover);
      } catch {
        /* no app yet */
      }
    }
    const ats = $("atsResumeText")?.value;
    if (ats != null && ats !== "") {
      try {
        await Api.saveAtsResume(ats);
      } catch {
        /* no app yet */
      }
    }
  }

  async function runAnalyze() {
    $("analyzeStatus").textContent = "running…";
    $("analyzeStatus").className = "badge warn";
    setError(null);
    try {
      await persistDraftInputs({ requireCv: true, requireJd: true });
      await loadCvUi();
      await loadProfileUi();

      // Pre-scan for UX (CV + JD PII already auto-approved on save)
      const cv = await Api.getCv();
      const app = await Api.getApplication();
      const unvetted = await Api.scanPii([cv?.text || "", app?.jobDescription || ""]);
      if (unvetted?.length) {
        // Still try; gate will block if needed — but show early
        showPiiReview(unvetted);
      }
      const result = await Api.runAnalyze();
      await loadAppUi();
      document.querySelector('[data-tab="result"]').click();
      await refreshAudit();

      if (result.status === "analyze_partial" || result.analyzeMode === "local") {
        $("analyzeStatus").textContent = "partial";
        $("analyzeStatus").className = "badge warn";
        const errMsg =
          result.analyzeError ||
          "LLM backends failed; local CV structure kept. Your CV/JD/profile were not discarded.";
        setStatus(
          `Partial analyze (local structure only). ${errMsg} Set an OpenAI API key in Options — it falls back automatically on any Grok failure (including X session 404).`,
          "warn"
        );
        setBanner("errorBanner", errMsg, "warn");
      } else {
        $("analyzeStatus").textContent =
          result.analyzeMode === "hooks-only" ? "hooks only" : "done";
        $("analyzeStatus").className =
          result.analyzeMode === "hooks-only" ? "badge warn" : "badge ok";
        setError(null);
        const modeNote =
          result.analyzeMode === "hooks-only"
            ? "Objective/summary/cover from pass 1; body filled from local CV structure."
            : result.analyzeMode === "two-pass"
              ? "Two-pass: aptitude intro first, then structured body."
              : `Mode: ${result.analyzeMode || "llm"}.`;
        setStatus(
          `Analyzed via ${result.grokBackend || "llm"}. ${modeNote} Review objective, summary, and cover letter — aptitude-first intro is critical.`,
          result.analyzeMode === "hooks-only" ? "warn" : "ok"
        );
      }
    } catch (err) {
      $("analyzeStatus").textContent = "error";
      $("analyzeStatus").className = "badge danger";
      if (err.code === "PII_REVIEW_REQUIRED" && err.unvetted) {
        showPiiReview(err.unvetted);
        setError(err);
      } else {
        setError(err);
        // Partial app / prior drafts may still exist — never wipe UI
        await loadAppUi().catch(() => {});
      }
      await refreshAudit();
    }
  }

  // Tabs
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
      const panel = $(`tab-${btn.dataset.tab}`);
      if (panel) panel.classList.remove("hidden");
    });
  });

  // Vault
  $("btnSetup").addEventListener("click", async () => {
    try {
      const a = $("setupPass").value;
      const b = $("setupPass2").value;
      if (a !== b) throw new Error("Passphrases do not match");
      await Api.setupPassphrase(a);
      setStatus("Vault created and unlocked.", "ok");
      await refreshVaultUi();
      await loadAll();
    } catch (err) {
      setError(err);
    }
  });

  $("btnUnlock").addEventListener("click", async () => {
    try {
      await Api.unlock($("unlockPass").value);
      $("unlockPass").value = "";
      setStatus("Unlocked.", "ok");
      await refreshVaultUi();
      await loadAll();
    } catch (err) {
      setError(err);
    }
  });
  $("unlockPass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btnUnlock").click();
  });

  $("btnLock").addEventListener("click", async () => {
    await Api.lock();
    setStatus("Locked.", "info");
    await refreshVaultUi();
  });

  function openOptions() {
    browser.runtime.openOptionsPage();
  }
  $("btnOpenOptions").addEventListener("click", openOptions);
  $("btnOpenOptionsLocked").addEventListener("click", openOptions);

  // CV
  $("btnSaveCv").addEventListener("click", async () => {
    try {
      await Api.setCvText($("cvText").value, { source: "paste", name: "pasted-cv" });
      setStatus("CV saved locally. Empty profile fields prefilled from contact lines when found.", "ok");
      await loadCvUi();
      await loadProfileUi();
    } catch (err) {
      setError(err);
    }
  });
  $("btnClearCv").addEventListener("click", async () => {
    try {
      await Api.clearCv();
      $("cvText").value = "";
      setStatus("CV cleared.", "info");
      await loadCvUi();
    } catch (err) {
      setError(err);
    }
  });

  $("btnSaveProfile").addEventListener("click", async () => {
    try {
      // Send every slot (empty string clears) so merge-based setProfile can drop blanks
      const profile = {};
      for (const k of PROFILE_KEYS) {
        const el = $(`pf_${k}`);
        profile[k] = el?.value?.trim() || "";
      }
      const saved = await Api.setProfile(profile);
      // Also approve profile values into PII allowlist for clarity
      const vals = Object.values(saved || {}).filter(Boolean);
      if (vals.length) await Api.approvePii(vals.map((v) => ({ value: v, type: "profile" })));
      setStatus("Profile saved (values allowed for Grok).", "ok");
      await loadProfileUi();
    } catch (err) {
      setError(err);
    }
  });

  $("btnGoogleConnect").addEventListener("click", async () => {
    try {
      const res = await Api.googleConnect();
      setStatus(
        res?.message ||
          "Google enabled via browser session (read-only). No client ID required.",
        "ok"
      );
      await refreshGoogle();
    } catch (err) {
      setError(err);
    }
  });

  $("btnGoogleList").addEventListener("click", async () => {
    try {
      const data = await Api.googleListDocs({ pageSize: 20 });
      const ul = $("docsList");
      ul.innerHTML = "";
      for (const f of data.files || []) {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = f.name;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sm";
        btn.textContent = "Import";
        btn.addEventListener("click", async () => {
          try {
            const cv = await Api.googleExportCv({ fileId: f.id, name: f.name });
            $("cvText").value = cv.text || "";
            setStatus(`Imported “${cv.name}” (${cv.chars} chars) read-only.`, "ok");
            await loadCvUi();
            await loadProfileUi();
          } catch (err) {
            setError(err);
          }
        });
        li.appendChild(name);
        li.appendChild(btn);
        ul.appendChild(li);
      }
      if (!(data.files || []).length) {
        ul.innerHTML = "<li class='muted'>No Google Docs found.</li>";
      }
    } catch (err) {
      setError(err);
    }
  });

  $("btnImportUrl").addEventListener("click", async () => {
    try {
      const url = $("docsUrl").value.trim();
      if (!url) throw new Error("Paste a Docs URL first");
      const cv = await Api.googleExportCv({ url });
      $("cvText").value = cv.text || "";
      setStatus(`Imported “${cv.name}” (${cv.chars} chars) read-only.`, "ok");
      await loadCvUi();
      await loadProfileUi();
    } catch (err) {
      setError(err);
    }
  });

  $("btnImportActiveDoc")?.addEventListener("click", async () => {
    try {
      const cv = await Api.googleImportActiveTab();
      $("cvText").value = cv.text || "";
      setStatus(
        `Imported open Doc “${cv.name}” (${cv.chars} chars) via read-only export.`,
        "ok"
      );
      await loadCvUi();
      await loadProfileUi();
    } catch (err) {
      setError(err);
    }
  });

  // Job
  $("btnCaptureJd").addEventListener("click", async () => {
    try {
      const app = await Api.captureJd();
      $("jobTitle").value = app.jobTitle || "";
      $("jobCompany").value = app.company || "";
      $("jdText").value = app.jobDescription || "";
      setStatus(
        `Captured JD (${(app.jobDescription || "").length} chars) from tab.`,
        app.jobDescription ? "ok" : "warn"
      );
    } catch (err) {
      setError(err);
    }
  });

  $("btnSaveJd").addEventListener("click", async () => {
    try {
      await Api.setJdText({
        text: $("jdText").value,
        jobTitle: $("jobTitle").value,
        company: $("jobCompany").value,
      });
      setStatus("Job description saved.", "ok");
    } catch (err) {
      setError(err);
    }
  });

  $("btnNewApp").addEventListener("click", async () => {
    try {
      const okConfirm = window.confirm(
        "Start a new global job draft?\n\n" +
          "The previous draft stays in history. CV and profile are kept."
      );
      if (!okConfirm) return;
      await Api.newApplication({});
      $("jobTitle").value = "";
      $("jobCompany").value = "";
      $("jdText").value = "";
      $("coverLetter").value = "";
      if ($("atsResumeText")) $("atsResumeText").value = "";
      $("emphasisList").innerHTML = "";
      $("distilledSummary").textContent = "—";
      $("atsNotes").textContent = "—";
      $("atsKeywords").textContent = "—";
      $("expList").textContent = "—";
      renderFieldMap([]);
      $("appStatus").textContent = "draft";
      setStatus("New job draft started (global session).", "ok");
    } catch (err) {
      setError(err);
    }
  });

  $("btnAnalyze").addEventListener("click", () => runAnalyze());

  $("btnSaveCover").addEventListener("click", async () => {
    try {
      await Api.saveCover($("coverLetter").value);
      setStatus("Cover letter saved.", "ok");
    } catch (err) {
      setError(err);
    }
  });

  $("btnSaveAtsResume")?.addEventListener("click", async () => {
    try {
      await Api.saveAtsResume($("atsResumeText").value);
      setStatus("ATS resume text saved.", "ok");
    } catch (err) {
      setError(err);
    }
  });

  $("btnCopyAtsResume")?.addEventListener("click", async () => {
    try {
      const t = $("atsResumeText").value || "";
      if (!t.trim()) throw new Error("Nothing to copy — run analyze first");
      await navigator.clipboard.writeText(t);
      setStatus("ATS resume text copied to clipboard.", "ok");
    } catch (err) {
      setError(err);
    }
  });

  $("btnMapFields").addEventListener("click", async () => {
    try {
      $("fillStatus").textContent = "mapping…";
      $("fillStatus").className = "badge warn";
      await persistDraftInputs();
      const app = await Api.mapFields({ useGrok: true });
      renderFieldMap(app.fieldMap || []);
      $("fillStatus").textContent = `${(app.fieldMap || []).filter((m) => m.value).length} mapped`;
      $("fillStatus").className = "badge ok";
      setStatus("Field map ready. Review then Fill.", "ok");
      await refreshAudit();
    } catch (err) {
      $("fillStatus").textContent = "error";
      $("fillStatus").className = "badge danger";
      if (err.code === "PII_REVIEW_REQUIRED") showPiiReview(err.unvetted);
      setError(err);
    }
  });

  $("btnFillForm").addEventListener("click", async () => {
    try {
      $("fillStatus").textContent = "filling…";
      $("fillStatus").className = "badge warn";
      await persistDraftInputs();
      const app = await Api.fillForm();
      const fr = app.fillResult || {};
      $("fillStatus").textContent = `filled ${fr.filled || 0}`;
      $("fillStatus").className = "badge ok";
      setStatus(
        `Filled ${fr.filled || 0} field(s). Review the page carefully — submission is never automated.`,
        "ok"
      );
      await refreshAudit();
    } catch (err) {
      $("fillStatus").textContent = "error";
      $("fillStatus").className = "badge danger";
      setError(err);
    }
  });

  $("btnRefreshAudit").addEventListener("click", () => refreshAudit());
  $("auditFilter")?.addEventListener("change", () => refreshAudit());

  async function loadAll() {
    setError(null);
    await loadCvUi();
    await loadProfileUi();
    await loadAppUi();
    await refreshGoogle();
    await refreshAudit();
  }

  // Keep every sidebar/popup/options instance synced to the single global application and session state
  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "event") {
      if (msg.event === "application.changed") {
        loadAppUi().catch(() => {});
      } else if (msg.event === "session.changed") {
        refreshVaultUi()
          .then((st) => {
            if (st.unlocked) return loadAll();
          })
          .catch((err) => setError(err));
      }
    }
  });

  // Init
  refreshVaultUi()
    .then((st) => {
      if (st.unlocked) return loadAll();
    })
    .catch((err) => setError(err));
})();
