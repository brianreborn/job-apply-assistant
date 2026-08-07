/**
 * Thin messaging helper for extension pages (popup / sidebar / options).
 * Works as a classic script: exposes window.JobApplyApi
 */
(function (global) {
  "use strict";

  function send(type, payload = {}) {
    return browser.runtime.sendMessage({ type, ...payload }).then((res) => {
      if (!res) throw new Error("No response from background");
      if (!res.ok) {
        const err = new Error(res.error || "Request failed");
        err.code = res.code || null;
        err.unvetted = res.unvetted || null;
        throw err;
      }
      return res.data;
    });
  }

  const Api = {
    send,
    sessionStatus: () => send("session.status"),
    setupPassphrase: (passphrase) => send("session.setup", { passphrase }),
    unlock: (passphrase) => send("session.unlock", { passphrase }),
    lock: () => send("session.lock"),

    getSettings: () => send("settings.get"),
    setSettings: (patch) => send("settings.set", { patch }),
    setXaiKey: (key) => send("settings.setXaiKey", { key }),
    setOpenaiKey: (key) => send("settings.setOpenaiKey", { key }),
    setGeminiKey: (key) => send("settings.setGeminiKey", { key }),
    setMsKey: (key, endpoint) => send("settings.setMsKey", { key, endpoint }),
    setGoogleClient: (clientId) => send("settings.setGoogleClient", { clientId }),

    listAccounts: () => send("accounts.list"),
    addAccount: (account) => send("accounts.add", { account }),
    removeAccount: (id) => send("accounts.remove", { id }),
    importBrowserX: () => send("accounts.importBrowserX"),
    rekeyAccounts: () => send("accounts.rekey"),

    googleConnect: () => send("google.connect"),
    googleDisconnect: () => send("google.disconnect"),
    googleStatus: () => send("google.status"),
    googleListDocs: (opts) => send("google.listDocs", { opts }),
    googleExportCv: (opts) => send("google.exportCv", opts),
    googleImportActiveTab: (tabId) => send("google.importActiveTab", { tabId }),

    setCvText: (text, meta) => send("cv.setText", { text, meta }),
    getCv: () => send("cv.get"),
    clearCv: () => send("cv.clear"),
    saveCover: (coverLetter) => send("pipeline.saveCover", { coverLetter }),
    saveAtsResume: (atsResumeText) =>
      send("pipeline.saveAtsResume", { atsResumeText }),

    getProfile: () => send("profile.get"),
    setProfile: (profile) => send("profile.set", { profile }),
    getPiiAllowlist: () => send("pii.getAllowlist"),
    setPiiAllowlist: (entries) => send("pii.setAllowlist", { entries }),
    approvePii: (values) => send("pii.approve", { values }),
    scanPii: (parts) => send("pii.scan", { parts }),

    captureJd: (tabId) => send("pipeline.captureJd", { tabId }),
    setJdText: (payload) => send("pipeline.setJdText", payload),
    runAnalyze: (opts) => send("pipeline.analyze", opts || {}),
    mapFields: (opts) => send("pipeline.mapFields", opts || {}),
    fillForm: (opts) => send("pipeline.fillForm", opts || {}),
    getApplication: () => send("pipeline.getApplication"),
    listApplications: () => send("pipeline.listApplications"),
    newApplication: (partial) => send("pipeline.newApplication", { partial: partial || {} }),

    auditList: (opts) => send("audit.list", { opts }),
    auditExport: (opts) => send("audit.export", { opts }),
    auditClear: () => send("audit.clear"),
  };

  global.JobApplyApi = Api;
})(typeof globalThis !== "undefined" ? globalThis : window);
