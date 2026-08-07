/**
 * Content-script message router for JobApply Assistant.
 */
(function () {
  "use strict";

  if (window.__jobApplyContentReady) return;
  window.__jobApplyContentReady = true;

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      const type = message?.type;
      if (type === "content.ping") {
        sendResponse({ ok: true, data: { pong: true, url: location.href } });
        return;
      }
      if (type === "content.extractJd") {
        const data = globalThis.JobApplyJd.extractJobDescription();
        sendResponse({ ok: true, data });
        return;
      }
      if (type === "content.scanForms") {
        const data = globalThis.JobApplyFormScanner.scanForms();
        sendResponse({ ok: true, data });
        return;
      }
      if (type === "content.fill") {
        // Re-scan so data-jobapply-id attributes exist
        globalThis.JobApplyFormScanner.scanForms();
        const data = globalThis.JobApplyFormFiller.fillFields(message.fills || []);
        sendResponse({ ok: true, data });
        return;
      }
      sendResponse({ ok: false, error: `Unknown content message: ${type}` });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false;
  });
})();
