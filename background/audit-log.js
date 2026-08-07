/**
 * Append-only structured audit trail for network and pipeline events.
 *
 * Primary logs come from clients (grok-client, google-drive) with purpose tags.
 * Secondary capture via webRequest covers all X / xAI / Google traffic that
 * passes through this Firefox profile — including extension-originated calls
 * and (optionally) passive X tab activity for a complete Twitter ops log.
 */

import { uuid, nowIso, redactUrl, channelFromUrl, truncate } from "../lib/util.js";
import { idbPut, idbGetAll, idbClear, getSettings } from "./secure-store.js";

/** In-memory requestId → partial row for pairing before/after events. */
const pendingRequests = new Map();
const PENDING_TTL_MS = 120_000;

/**
 * @param {object} entry
 */
export async function audit(entry) {
  const row = {
    id: uuid(),
    ts: nowIso(),
    channel: entry.channel || (entry.url ? channelFromUrl(entry.url) : "local"),
    method: entry.method || null,
    url: entry.url ? redactUrl(entry.url) : null,
    accountId: entry.accountId || null,
    purpose: entry.purpose || "unknown",
    requestMeta: entry.requestMeta || null,
    responseMeta: entry.responseMeta || null,
    error: entry.error ? truncate(String(entry.error), 500) : null,
    note: entry.note ? truncate(entry.note, 500) : null,
  };
  await idbPut("audit", row);
  return row;
}

export async function listAudit({ limit = 200, channel = null, purpose = null } = {}) {
  let rows = await idbGetAll("audit");
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  if (channel) rows = rows.filter((r) => r.channel === channel);
  if (purpose) {
    const p = String(purpose).toLowerCase();
    rows = rows.filter(
      (r) =>
        String(r.purpose || "")
          .toLowerCase()
          .includes(p) ||
        String(r.note || "")
          .toLowerCase()
          .includes(p)
    );
  }
  return rows.slice(0, limit);
}

export async function exportAuditJsonl({ limit = 5000, channel = null } = {}) {
  const rows = await listAudit({ limit, channel });
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

export async function clearAudit() {
  await idbClear("audit");
  pendingRequests.clear();
}

/** Best-effort retention prune. */
export async function pruneAudit() {
  const settings = await getSettings();
  const days = settings.auditRetentionDays;
  if (!days || days <= 0) return 0;
  const cutoff = Date.now() - days * 86400000;
  const rows = await idbGetAll("audit");
  let n = 0;
  for (const r of rows) {
    if (new Date(r.ts).getTime() < cutoff) {
      const { idbDelete } = await import("./secure-store.js");
      await idbDelete("audit", r.id);
      n++;
    }
  }
  return n;
}

function classifyXPurpose(url, type) {
  try {
    const u = new URL(url);
    const path = u.pathname || "";
    if (/\/2\/grok\//i.test(path) || /grok\.x\.com/i.test(u.hostname)) return "x.grok";
    if (/\/i\/api\//i.test(path) || /\/graphql\//i.test(path)) return "x.api";
    if (/\/1\.1\//i.test(path) || /\/2\//i.test(path)) return "x.api";
    if (type === "xmlhttprequest" || type === "fetch") return "x.xhr";
    if (type === "websocket") return "x.ws";
    if (type === "main_frame" || type === "sub_frame") return "x.navigation";
    if (type === "script" || type === "stylesheet" || type === "image" || type === "font")
      return "x.asset";
    return "x.other";
  } catch {
    return "x.other";
  }
}

function shouldLogSecondary(url, type) {
  // Skip pure static assets to keep the trail useful for "network ops"
  if (type === "image" || type === "font" || type === "media" || type === "stylesheet") {
    return false;
  }
  // Still log scripts on X API hosts — often carry ops; skip CDN bulk
  if (type === "script") {
    try {
      const h = new URL(url).hostname;
      if (/abs\.twimg\.com|pbs\.twimg\.com|ton\.twitter\.com/i.test(h)) return false;
    } catch {
      /* */
    }
  }
  return true;
}

function initiatorKind(details) {
  // Firefox may provide originUrl / documentUrl
  const origin = details.originUrl || details.documentUrl || "";
  if (!origin) return "unknown";
  try {
    if (origin.startsWith("moz-extension://") || origin.startsWith("chrome-extension://")) {
      return "extension";
    }
    const h = new URL(origin).hostname;
    if (/x\.com|twitter\.com|grok\.x\.com/i.test(h)) return "x-tab";
    if (/google\.com|googleapis\.com/i.test(h)) return "google-tab";
    return "page";
  } catch {
    return "unknown";
  }
}

function purgeStalePending() {
  const now = Date.now();
  for (const [id, rec] of pendingRequests) {
    if (now - rec.t0 > PENDING_TTL_MS) pendingRequests.delete(id);
  }
}

/**
 * Install webRequest listeners for secondary capture of X/Google/xAI traffic.
 * Pairs onBeforeRequest with onCompleted/onError for a structured ops log.
 * Never stores cookies, auth headers, or request bodies.
 */
export function installWebRequestAudit() {
  if (!browser.webRequest?.onCompleted) return;

  const filter = {
    urls: [
      "https://x.com/*",
      "https://twitter.com/*",
      "https://api.x.com/*",
      "https://api.twitter.com/*",
      "https://grok.x.com/*",
      "https://api.x.ai/*",
      "https://www.googleapis.com/*",
      "https://docs.google.com/*",
      "https://drive.google.com/*",
      "https://accounts.google.com/*",
    ],
  };

  if (browser.webRequest.onBeforeRequest) {
    browser.webRequest.onBeforeRequest.addListener((details) => {
      if (!shouldLogSecondary(details.url, details.type)) return;
      purgeStalePending();
      const channel = channelFromUrl(details.url);
      const purpose =
        channel === "x.com"
          ? classifyXPurpose(details.url, details.type)
          : channel === "api.x.ai"
            ? "xai.webRequest"
            : channel === "googleapis"
              ? "google.webRequest"
              : "webRequest.before";
      pendingRequests.set(details.requestId, {
        t0: Date.now(),
        method: details.method,
        url: details.url,
        type: details.type,
        tabId: details.tabId,
        channel,
        purpose,
        initiator: initiatorKind(details),
      });
    }, filter);
  }

  browser.webRequest.onCompleted.addListener((details) => {
    if (!shouldLogSecondary(details.url, details.type)) return;
    const pending = pendingRequests.get(details.requestId);
    pendingRequests.delete(details.requestId);
    const channel = channelFromUrl(details.url);
    const purpose =
      pending?.purpose ||
      (channel === "x.com"
        ? classifyXPurpose(details.url, details.type)
        : "webRequest.completed");
    const durationMs = pending ? Date.now() - pending.t0 : null;
    audit({
      channel,
      method: details.method || pending?.method,
      url: details.url,
      purpose,
      requestMeta: {
        type: details.type,
        tabId: details.tabId,
        initiator: pending?.initiator || initiatorKind(details),
        requestId: details.requestId,
        fromCapture: "webRequest",
      },
      responseMeta: {
        status: details.statusCode,
        type: details.type,
        fromCache: details.fromCache,
        tabId: details.tabId,
        durationMs,
        ip: details.ip || null,
      },
      note: "secondary capture · paired",
    }).catch(() => {});
  }, filter);

  browser.webRequest.onErrorOccurred?.addListener((details) => {
    if (!shouldLogSecondary(details.url, details.type)) return;
    const pending = pendingRequests.get(details.requestId);
    pendingRequests.delete(details.requestId);
    audit({
      channel: channelFromUrl(details.url),
      method: details.method || pending?.method,
      url: details.url,
      purpose: pending?.purpose || "webRequest.error",
      requestMeta: {
        type: details.type,
        tabId: details.tabId,
        initiator: pending?.initiator || initiatorKind(details),
        requestId: details.requestId,
        fromCapture: "webRequest",
      },
      error: details.error,
      note: "secondary capture · error",
    }).catch(() => {});
  }, filter);
}
