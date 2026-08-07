/** Message type constants for UI ↔ background ↔ content. */

export const MSG = {
  // Session / crypto
  UNLOCK: "session.unlock",
  LOCK: "session.lock",
  SESSION_STATUS: "session.status",
  SETUP_PASSPHRASE: "session.setup",

  // Settings
  GET_SETTINGS: "settings.get",
  SET_SETTINGS: "settings.set",
  SET_XAI_KEY: "settings.setXaiKey",
  SET_OPENAI_KEY: "settings.setOpenaiKey",
  SET_GEMINI_KEY: "settings.setGeminiKey",
  SET_MS_KEY: "settings.setMsKey",
  SET_GOOGLE_CLIENT: "settings.setGoogleClient",

  // Accounts (X)
  LIST_ACCOUNTS: "accounts.list",
  ADD_ACCOUNT: "accounts.add",
  REMOVE_ACCOUNT: "accounts.remove",
  IMPORT_BROWSER_X: "accounts.importBrowserX",
  REKEY_ACCOUNTS: "accounts.rekey",

  // Google Drive
  GOOGLE_CONNECT: "google.connect",
  GOOGLE_DISCONNECT: "google.disconnect",
  GOOGLE_STATUS: "google.status",
  GOOGLE_LIST_DOCS: "google.listDocs",
  GOOGLE_EXPORT_CV: "google.exportCv",
  GOOGLE_IMPORT_ACTIVE_TAB: "google.importActiveTab",

  // CV
  SET_CV_TEXT: "cv.setText",
  GET_CV: "cv.get",
  CLEAR_CV: "cv.clear",
  SAVE_COVER: "pipeline.saveCover",
  SAVE_ATS_RESUME: "pipeline.saveAtsResume",

  // Profile / PII
  GET_PROFILE: "profile.get",
  SET_PROFILE: "profile.set",
  GET_PII_ALLOWLIST: "pii.getAllowlist",
  SET_PII_ALLOWLIST: "pii.setAllowlist",
  APPROVE_PII: "pii.approve",
  SCAN_PII: "pii.scan",

  // Pipeline
  CAPTURE_JD: "pipeline.captureJd",
  SET_JD_TEXT: "pipeline.setJdText",
  RUN_ANALYZE: "pipeline.analyze",
  MAP_FIELDS: "pipeline.mapFields",
  FILL_FORM: "pipeline.fillForm",
  GET_APPLICATION: "pipeline.getApplication",
  LIST_APPLICATIONS: "pipeline.listApplications",
  NEW_APPLICATION: "pipeline.newApplication",

  // Content script ops
  CONTENT_SCAN_FORMS: "content.scanForms",
  CONTENT_EXTRACT_JD: "content.extractJd",
  CONTENT_FILL: "content.fill",
  CONTENT_PING: "content.ping",

  // Audit
  AUDIT_LIST: "audit.list",
  AUDIT_EXPORT: "audit.export",
  AUDIT_CLEAR: "audit.clear",

  // Events (broadcast UI sync)
  EVENT: "event",
};

export function ok(data = null) {
  return { ok: true, data };
}

export function fail(error, extra = {}) {
  return { ok: false, error: String(error?.message || error), ...extra };
}
