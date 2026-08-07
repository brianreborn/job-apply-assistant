(function () {
  "use strict";
  const Api = window.JobApplyApi;
  const $ = (id) => document.getElementById(id);

  function show(el, on) {
    el.classList.toggle("hidden", !on);
  }
  function msg(text, kind = "info") {
    const el = $("msg");
    if (!text) {
      show(el, false);
      return;
    }
    el.className = `banner ${kind}`;
    el.textContent = text;
    show(el, true);
  }

  async function refresh() {
    const st = await Api.sessionStatus();
    const badge = $("badge");
    if (!st.setup) {
      badge.textContent = "setup";
      badge.className = "badge warn";
      show($("locked"), false);
      show($("open"), false);
      msg("Open the sidebar to create your vault passphrase.", "warn");
      return;
    }
    if (!st.unlocked) {
      badge.textContent = "locked";
      badge.className = "badge danger";
      show($("locked"), true);
      show($("open"), false);
      return;
    }
    badge.textContent = "ready";
    badge.className = "badge ok";
    show($("locked"), false);
    show($("open"), true);
    try {
      const app = await Api.getApplication();
      const cv = await Api.getCv();
      $("hint").textContent = [
        cv?.text ? `CV: ${cv.text.length} chars` : "No CV",
        app?.status ? `App: ${app.status}` : "No app yet",
      ].join(" · ");
    } catch {
      $("hint").textContent = "";
    }
  }

  $("btnUnlock").addEventListener("click", async () => {
    try {
      await Api.unlock($("pass").value);
      $("pass").value = "";
      msg("Unlocked.", "ok");
      await refresh();
    } catch (e) {
      msg(e.message, "danger");
    }
  });
  $("pass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btnUnlock").click();
  });

  $("btnLock").addEventListener("click", async () => {
    await Api.lock();
    await refresh();
  });

  $("btnCapture").addEventListener("click", async () => {
    try {
      const app = await Api.captureJd();
      msg(`JD captured (${(app.jobDescription || "").length} chars).`, "ok");
      await refresh();
    } catch (e) {
      msg(e.message, "danger");
    }
  });

  $("btnAnalyze").addEventListener("click", async () => {
    try {
      msg("Analyzing…", "info");
      const app = await Api.runAnalyze();
      msg(`Analyzed (${app.grokBackend || "partial"}). Open sidebar for cover letter.`, "ok");
      await refresh();
    } catch (e) {
      let m = e.message;
      if (e.code === "PII_REVIEW_REQUIRED") m += " Use sidebar to approve PII.";
      if (e.code === "NEED_MORE_ACCOUNTS") m += " Add key/accounts in Options.";
      msg(m, "danger");
    }
  });

  $("btnFill").addEventListener("click", async () => {
    try {
      const app = await Api.fillForm();
      msg(`Filled ${app.fillResult?.filled || 0} fields. Review & submit yourself.`, "ok");
    } catch (e) {
      msg(e.message, "danger");
    }
  });

  $("btnOptions").addEventListener("click", () => browser.runtime.openOptionsPage());
  $("btnSidebar").addEventListener("click", async () => {
    try {
      if (browser.sidebarAction?.open) await browser.sidebarAction.open();
      else msg("Open the sidebar from the Firefox sidebar menu.", "info");
    } catch {
      msg("Open the sidebar from the Firefox View → Sidebar menu.", "info");
    }
  });

  browser.runtime.onMessage.addListener((m) => {
    if (m?.type === "event") {
      if (m.event === "session.changed" || m.event === "application.changed") {
        refresh().catch(() => {});
      }
    }
  });

  refresh().catch((e) => msg(e.message, "danger"));
})();
