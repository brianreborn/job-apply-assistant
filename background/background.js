/**
 * JobApply Assistant — background event page (ES module).
 * Routes messages between UI, content scripts, and services.
 */

import { MSG, ok, fail } from "../lib/messages.js";
import {
  setupPassphrase,
  unlock,
  lock,
  sessionStatus,
  getSettings,
  patchSettings,
  getProfile,
  setProfile,
  getPiiAllowlist,
  setPiiAllowlist,
  isUnlocked,
} from "./secure-store.js";
import { installWebRequestAudit, listAudit, exportAuditJsonl, clearAudit, pruneAudit, audit } from "./audit-log.js";
import {
  listPool,
  addPoolAccount,
  removePoolAccount,
  importBrowserXSessions,
  rekeyPool,
} from "./account-pool.js";
import {
  connectGoogle,
  disconnectGoogle,
  googleStatus,
  listDocs,
  exportCvPlainText,
  parseDocsUrl,
} from "./google-drive.js";
import { approvePiiValues, scanForReview } from "./pii-gate.js";
import {
  setCvText,
  getCurrentCv,
  clearCurrentCv,
  setJdText,
  captureJdFromTab,
  runAnalyze,
  mapFieldsForTab,
  fillFormOnTab,
  getCurrentApplication,
  listApplications,
  activeTabId,
  saveCoverLetter,
  saveAtsResumeText,
  newApplication,
  importCvFromActiveTab,
} from "./pipeline.js";

installWebRequestAudit();

browser.runtime.onInstalled.addListener(() => {
  audit({ purpose: "extension.installed", channel: "local" }).catch(() => {});
});

browser.alarms.create("audit-prune", { periodInMinutes: 60 * 12 });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "audit-prune") pruneAudit().catch(() => {});
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then(sendResponse)
    .catch((err) => {
      const payload = fail(err);
      if (err.code) payload.code = err.code;
      if (err.unvetted) payload.unvetted = err.unvetted;
      sendResponse(payload);
    });
  return true; // async
});

async function handle(message, sender) {
  const type = message?.type;
  if (!type) return fail("Missing message type");

  switch (type) {
    case MSG.SESSION_STATUS:
      return ok(await sessionStatus());

    case MSG.SETUP_PASSPHRASE: {
      const res = await setupPassphrase(message.passphrase);
      notifySessionStatus();
      return ok(res);
    }

    case MSG.UNLOCK: {
      const res = await unlock(message.passphrase);
      notifySessionStatus();
      return ok(res);
    }

    case MSG.LOCK:
      lock();
      notifySessionStatus();
      return ok({ unlocked: false });

    case MSG.GET_SETTINGS: {
      const s = await getSettings();
      delete s._secrets;
      return ok(s);
    }

    case MSG.SET_SETTINGS:
      return ok(await patchSettings(message.patch || {}, null));

    case MSG.SET_XAI_KEY: {
      requireUnlock();
      const key = message.key && String(message.key).trim() ? String(message.key).trim() : null;
      await patchSettings(null, {
        xaiApiKey: key,
      });
      return ok({ hasXaiKey: Boolean(key) });
    }

    case MSG.SET_OPENAI_KEY: {
      requireUnlock();
      const key = message.key && String(message.key).trim() ? String(message.key).trim() : null;
      await patchSettings(null, {
        openaiApiKey: key,
      });
      return ok({ hasOpenaiKey: Boolean(key) });
    }

    case MSG.SET_GEMINI_KEY: {
      requireUnlock();
      const key = message.key && String(message.key).trim() ? String(message.key).trim() : null;
      await patchSettings(null, {
        geminiApiKey: key,
      });
      return ok({ hasGeminiKey: Boolean(key) });
    }

    case MSG.SET_MS_KEY: {
      requireUnlock();
      const key = message.key && String(message.key).trim() ? String(message.key).trim() : null;
      const patchObj = { msApiKey: key };
      if ("endpoint" in message) {
        await patchSettings({ msEndpoint: String(message.endpoint || "").trim() }, patchObj);
      } else {
        await patchSettings(null, patchObj);
      }
      return ok({ hasMsKey: Boolean(key) });
    }

    case MSG.SET_GOOGLE_CLIENT:
      return ok(await patchSettings({ googleClientId: message.clientId || "" }, null));

    case MSG.LIST_ACCOUNTS:
      requireUnlock();
      // rekey=true collapses legacy UUID rows onto unique x:username keys
      return ok(await listPool({ rekey: message.rekey !== false }));

    case MSG.ADD_ACCOUNT:
      requireUnlock();
      return ok(await addPoolAccount(message.account || message));

    case MSG.REMOVE_ACCOUNT:
      requireUnlock();
      await removePoolAccount(message.id);
      return ok(true);

    case MSG.IMPORT_BROWSER_X:
      requireUnlock();
      return ok(await importBrowserXSessions());

    case MSG.REKEY_ACCOUNTS:
      requireUnlock();
      return ok(await rekeyPool());

    case MSG.GOOGLE_CONNECT:
      requireUnlock();
      return ok(await connectGoogle());

    case MSG.GOOGLE_DISCONNECT:
      requireUnlock();
      return ok(await disconnectGoogle());

    case MSG.GOOGLE_STATUS:
      return ok(await googleStatus());

    case MSG.GOOGLE_LIST_DOCS:
      requireUnlock();
      return ok(await listDocs(message.opts || {}));

    case MSG.GOOGLE_EXPORT_CV: {
      requireUnlock();
      let fileId = message.fileId;
      if (!fileId && message.url) fileId = parseDocsUrl(message.url);
      if (!fileId) return fail("fileId or Docs URL required");
      return ok(await exportCvPlainText(fileId, { name: message.name }));
    }

    case MSG.GOOGLE_IMPORT_ACTIVE_TAB: {
      requireUnlock();
      const tabId = message.tabId || (await activeTabId());
      if (!tabId) return fail("No active tab");
      return ok(await importCvFromActiveTab(tabId));
    }

    case MSG.SET_CV_TEXT:
      requireUnlock();
      return ok(await setCvText(message.text, message.meta || {}));

    case MSG.GET_CV:
      return ok(await getCurrentCv());

    case MSG.CLEAR_CV:
      requireUnlock();
      return ok(await clearCurrentCv());

    case MSG.SAVE_COVER:
      requireUnlock();
      return ok(await saveCoverLetter(message.coverLetter ?? ""));

    case MSG.SAVE_ATS_RESUME:
      requireUnlock();
      return ok(await saveAtsResumeText(message.atsResumeText ?? ""));

    case MSG.GET_PROFILE:
      return ok(await getProfile());

    case MSG.SET_PROFILE:
      requireUnlock();
      return ok(await setProfile(message.profile || {}));

    case MSG.GET_PII_ALLOWLIST:
      return ok(await getPiiAllowlist());

    case MSG.SET_PII_ALLOWLIST:
      requireUnlock();
      return ok(await setPiiAllowlist(message.entries || []));

    case MSG.APPROVE_PII:
      requireUnlock();
      return ok(await approvePiiValues(message.values || []));

    case MSG.SCAN_PII:
      return ok(await scanForReview(message.parts || []));

    case MSG.CAPTURE_JD: {
      requireUnlock();
      const tabId = message.tabId || (await activeTabId());
      if (!tabId) return fail("No active tab");
      return ok(await captureJdFromTab(tabId));
    }

    case MSG.SET_JD_TEXT:
      requireUnlock();
      return ok(await setJdText(message));

    case MSG.RUN_ANALYZE:
      requireUnlock();
      return ok(await runAnalyze({ forceRedact: message.forceRedact }));

    case MSG.MAP_FIELDS: {
      requireUnlock();
      const tabId = message.tabId || (await activeTabId());
      if (!tabId) return fail("No active tab");
      return ok(await mapFieldsForTab(tabId, { useGrok: message.useGrok !== false }));
    }

    case MSG.FILL_FORM: {
      requireUnlock();
      const tabId = message.tabId || (await activeTabId());
      if (!tabId) return fail("No active tab");
      return ok(await fillFormOnTab(tabId));
    }

    case MSG.GET_APPLICATION:
      return ok(await getCurrentApplication());

    case MSG.LIST_APPLICATIONS:
      return ok(await listApplications());

    case MSG.NEW_APPLICATION:
      requireUnlock();
      return ok(await newApplication(message.partial || {}));

    case MSG.AUDIT_LIST:
      return ok(await listAudit(message.opts || {}));

    case MSG.AUDIT_EXPORT:
      return ok(await exportAuditJsonl(message.opts || {}));

    case MSG.AUDIT_CLEAR:
      await clearAudit();
      return ok(true);

    case MSG.CONTENT_PING:
      return ok({ pong: true, from: "background", tab: sender.tab?.id });

    // Broadcasts from pipeline → UI (sidebar/popup); background ignores
    case MSG.EVENT:
      return ok({ ignored: true });

    default:
      return fail(`Unknown message type: ${type}`);
  }
}

function requireUnlock() {
  if (!isUnlocked()) {
    const err = new Error("Vault is locked — unlock in the side panel");
    err.code = "LOCKED";
    throw err;
  }
}

function notifySessionStatus() {
  sessionStatus()
    .then((st) => {
      browser.runtime
        .sendMessage({
          type: MSG.EVENT,
          event: "session.changed",
          status: st,
        })
        .catch(() => {});
    })
    .catch(() => {});
}

console.info("[JobApply] background ready");
