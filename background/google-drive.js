/**
 * Google Drive / Docs read-only CV ingest.
 *
 * Default path: browser Google session already logged into this Firefox profile.
 *   - No Google Cloud project, no OAuth client ID, no extra config.
 *   - Enable once ("Connect Google") after signing into Google in Firefox.
 *   - Export uses Docs/Drive web export endpoints with session cookies.
 *   - List uses Drive API with SAPISIDHASH when cookies allow it.
 *
 * Optional advanced path: OAuth client ID + launchWebAuthFlow (API tokens).
 *
 * Never writes or mutates Drive files or metadata.
 */

import { bytesOf, nowIso } from "../lib/util.js";
import {
  getSettings,
  getSecrets,
  patchSettings,
  isUnlocked,
  saveCv,
  getProfile,
  setProfile,
} from "./secure-store.js";
import { audit } from "./audit-log.js";
import { findPiiCandidates } from "../lib/redaction.js";
import { approvePiiValues } from "./pii-gate.js";
import { extractContactFromCv } from "../lib/ats-resume.js";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
].join(" ");

const DOC_MIME = "application/vnd.google-apps.document";
const TEXT_MIME_PREFIX = "text/";

// --- Session helpers -------------------------------------------------------

async function sha1Hex(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Collect Google auth cookies present in this Firefox profile.
 */
export async function getGoogleCookieSnapshot() {
  const domains = [".google.com", "google.com", ".docs.google.com", "docs.google.com"];
  const byName = new Map();
  for (const domain of domains) {
    try {
      const cookies = await browser.cookies.getAll({ domain });
      for (const c of cookies) {
        if (!byName.has(c.name)) byName.set(c.name, c.value);
      }
    } catch {
      /* permission edge */
    }
  }
  // Also try URL-scoped reads (Secure cookies)
  for (const url of [
    "https://drive.google.com/",
    "https://docs.google.com/",
    "https://accounts.google.com/",
  ]) {
    for (const name of [
      "SID",
      "HSID",
      "SSID",
      "APISID",
      "SAPISID",
      "__Secure-1PSID",
      "__Secure-3PSID",
      "__Secure-1PAPISID",
      "__Secure-3PAPISID",
    ]) {
      try {
        const c = await browser.cookies.get({ url, name });
        if (c?.value && !byName.has(name)) byName.set(name, c.value);
      } catch {
        /* */
      }
    }
  }
  return byName;
}

function hasSessionCookies(map) {
  // Any of these indicate a signed-in Google account in this profile
  return (
    map.has("SID") ||
    map.has("__Secure-1PSID") ||
    map.has("__Secure-3PSID") ||
    map.has("SAPISID") ||
    map.has("__Secure-1PAPISID") ||
    map.has("__Secure-3PAPISID")
  );
}

/**
 * Build SAPISIDHASH Authorization used by Google web clients.
 * Lets us call Drive API read endpoints without an OAuth client id.
 */
async function buildSapisidAuth(origin = "https://drive.google.com") {
  const map = await getGoogleCookieSnapshot();
  const sapisid =
    map.get("SAPISID") ||
    map.get("__Secure-1PAPISID") ||
    map.get("__Secure-3PAPISID") ||
    map.get("APISID");
  if (!sapisid) return null;
  const ts = Math.floor(Date.now() / 1000);
  const digest = await sha1Hex(`${ts} ${sapisid} ${origin}`);
  return `SAPISIDHASH ${ts}_${digest}`;
}

/**
 * Probe whether this Firefox profile is logged into Google (consumer account is fine).
 * Read-only GETs only.
 */
export async function probeGoogleSession() {
  const cookies = await getGoogleCookieSnapshot();
  if (!hasSessionCookies(cookies)) {
    return { loggedIn: false, reason: "no_cookies" };
  }

  // Prefer a lightweight Drive page — 200 + not accounts login means session is live
  try {
    const res = await fetch("https://drive.google.com/drive/my-drive", {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      headers: { Accept: "text/html" },
    });
    const finalUrl = res.url || "";
    const text = await res.text();
    await audit({
      channel: "googleapis",
      method: "GET",
      url: "https://drive.google.com/drive/my-drive",
      purpose: "google.session.probe",
      responseMeta: { status: res.status, bytes: bytesOf(text), finalHost: safeHost(finalUrl) },
    });

    if (/accounts\.google\.com/i.test(finalUrl)) {
      return { loggedIn: false, reason: "login_redirect" };
    }
    if (res.ok && !looksLikeGoogleLoginHtml(text)) {
      const email = extractEmailFromHtml(text);
      return { loggedIn: true, email, reason: "drive_ok" };
    }
  } catch (err) {
    await audit({
      purpose: "google.session.probe",
      channel: "googleapis",
      error: String(err.message || err),
    });
  }

  // Cookie present but probe inconclusive — still treat as available for export attempts
  return {
    loggedIn: true,
    email: null,
    reason: "cookies_only",
    soft: true,
  };
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function looksLikeGoogleLoginHtml(html) {
  if (!html || html.length < 50) return true;
  const head = html.slice(0, 4000).toLowerCase();
  if (head.includes("servicelogin") || head.includes("identifierid")) return true;
  if (head.includes("sign in") && head.includes("accounts.google") && !head.includes("drive"))
    return true;
  return false;
}

function looksLikeHtmlNotPlainText(body, contentType) {
  if (contentType && /text\/html/i.test(contentType)) return true;
  const t = (body || "").trimStart().slice(0, 200).toLowerCase();
  return t.startsWith("<!doctype") || t.startsWith("<html") || t.startsWith("<head");
}

function extractEmailFromHtml(html) {
  const m =
    html.match(/[A-Z0-9._%+-]+@gmail\.com/i) ||
    html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}

// --- Public connect / status -----------------------------------------------

/**
 * Enable Google CV import using the existing browser session.
 * No OAuth client id. User must already be signed into Google in this Firefox profile.
 * If an OAuth client id is configured, falls back to OAuth when session is unavailable.
 */
export async function connectGoogle() {
  if (!isUnlocked()) throw new Error("Vault locked");

  const settings = await getSettings();

  // 1) Preferred: zero-config browser session
  const session = await probeGoogleSession();
  if (session.loggedIn) {
    await patchSettings({ googleSessionEnabled: true }, null);
    await audit({
      purpose: "google.session.enable",
      channel: "local",
      note: session.email
        ? `session enabled · ${session.email}`
        : `session enabled · ${session.reason}`,
    });
    return {
      connected: true,
      mode: "session",
      email: session.email || null,
      message:
        "Using your existing Google login in Firefox. No Cloud project or client ID needed.",
    };
  }

  // 2) Optional: OAuth if user configured a client id
  if (settings.googleClientId) {
    return connectGoogleOAuth();
  }

  const err = new Error(
    "Not signed into Google in this Firefox profile. Open https://drive.google.com and sign in with your personal account, then click Connect again. No API keys or Cloud setup required."
  );
  err.code = "GOOGLE_SESSION_REQUIRED";
  throw err;
}

/**
 * Advanced: OAuth via browser.identity (requires googleClientId in Options).
 */
export async function connectGoogleOAuth() {
  if (!isUnlocked()) throw new Error("Vault locked");
  const settings = await getSettings();
  const clientId = settings.googleClientId;
  if (!clientId) {
    throw new Error(
      "OAuth client ID not set. For a normal personal Google account, use session Connect instead (no client ID)."
    );
  }

  const redirectURL = browser.identity.getRedirectURL();
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      response_type: "token",
      redirect_uri: redirectURL,
      scope: SCOPES,
      include_granted_scopes: "true",
      prompt: "select_account",
    }).toString();

  await audit({
    purpose: "google.oauth.start",
    channel: "googleapis",
    url: "https://accounts.google.com/o/oauth2/v2/auth",
    note: "read-only scopes only",
  });

  const responseUrl = await browser.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  const hash = new URL(responseUrl).hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const access_token = params.get("access_token");
  const expires_in = Number(params.get("expires_in") || 3600);
  if (!access_token) {
    throw new Error("Google OAuth failed: no access_token in redirect");
  }

  const tokens = {
    access_token,
    token_type: params.get("token_type") || "Bearer",
    expires_at: Date.now() + expires_in * 1000 - 60_000,
    scope: params.get("scope") || SCOPES,
  };

  assertReadonlyScopes(tokens.scope);

  await patchSettings({ googleSessionEnabled: false }, { googleTokens: tokens });
  await audit({
    purpose: "google.oauth.success",
    channel: "googleapis",
    note: "tokens stored encrypted; read-only",
  });
  return { connected: true, mode: "oauth", scope: tokens.scope };
}

function assertReadonlyScopes(scope) {
  const parts = String(scope || "")
    .split(/\s+/)
    .filter(Boolean);
  const bad = parts.filter(
    (p) =>
      /googleapis\.com\/auth\/(drive|documents)/i.test(p) && !/\.readonly$/i.test(p)
  );
  if (bad.length) {
    throw new Error(`Refusing Google tokens with non-readonly scopes: ${bad.join(", ")}`);
  }
}

export async function disconnectGoogle() {
  await patchSettings({ googleSessionEnabled: false }, { googleTokens: null });
  await audit({ purpose: "google.disconnect", channel: "local" });
  return { connected: false };
}

export async function googleStatus() {
  const settings = await getSettings();
  let oauthConnected = false;
  let expiresAt = null;
  if (isUnlocked()) {
    try {
      const secrets = await getSecrets();
      oauthConnected = Boolean(secrets.googleTokens?.access_token);
      expiresAt = secrets.googleTokens?.expires_at || null;
    } catch {
      /* */
    }
  }

  let session = { loggedIn: false };
  try {
    session = await probeGoogleSession();
  } catch {
    /* */
  }

  const sessionEnabled = settings.googleSessionEnabled !== false; // default on once probed
  // "Connected" for UI: session logged in (preferred) OR oauth tokens present
  const sessionActive = session.loggedIn && sessionEnabled;
  // Auto-treat as ready when logged into Google even before explicit Connect,
  // so "enable" is really just being signed in. Explicit Connect still sets the flag.
  const ready =
    oauthConnected ||
    session.loggedIn ||
    (settings.googleSessionEnabled && session.loggedIn);

  let mode = "none";
  if (oauthConnected) mode = "oauth";
  else if (session.loggedIn) mode = "session";

  return {
    connected: Boolean(ready),
    mode,
    sessionLoggedIn: Boolean(session.loggedIn),
    sessionEnabled: Boolean(settings.googleSessionEnabled),
    sessionEmail: session.email || null,
    sessionReason: session.reason || null,
    expiresAt,
    hasClientId: Boolean(settings.googleClientId),
    scopes: SCOPES,
    needsSignIn: !session.loggedIn && !oauthConnected,
    message: statusMessage({
      oauthConnected,
      session,
      hasClientId: Boolean(settings.googleClientId),
    }),
  };
}

function statusMessage({ oauthConnected, session, hasClientId }) {
  if (oauthConnected) return "Connected via OAuth token (advanced).";
  if (session.loggedIn) {
    return session.email
      ? `Using browser Google session (${session.email}).`
      : "Using browser Google session — no client ID required.";
  }
  if (hasClientId) {
    return "Not signed in. Sign into Google in Firefox, or use OAuth Connect.";
  }
  return "Sign into https://drive.google.com in this Firefox profile, then Connect.";
}

// --- Auth resolution for API calls -----------------------------------------

async function resolveAuth() {
  // Prefer OAuth token if present and fresh
  if (isUnlocked()) {
    try {
      const secrets = await getSecrets();
      const t = secrets.googleTokens;
      if (t?.access_token) {
        if (t.expires_at && Date.now() > t.expires_at) {
          // fall through to session
        } else {
          return { kind: "oauth", token: t.access_token };
        }
      }
    } catch {
      /* */
    }
  }

  const session = await probeGoogleSession();
  if (!session.loggedIn) {
    const err = new Error(
      "Not signed into Google in this Firefox profile. Open drive.google.com, sign in, then retry."
    );
    err.code = "GOOGLE_SESSION_REQUIRED";
    throw err;
  }

  const sapisid = await buildSapisidAuth("https://www.googleapis.com");
  const sapisidDrive = await buildSapisidAuth("https://drive.google.com");
  return {
    kind: "session",
    sapisidAuthApi: sapisid,
    sapisidAuthDrive: sapisidDrive,
  };
}

function oauthHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function sessionApiHeaders(auth) {
  const h = {
    Accept: "application/json",
    "X-Goog-AuthUser": "0",
  };
  if (auth.sapisidAuthApi) h.Authorization = auth.sapisidAuthApi;
  else if (auth.sapisidAuthDrive) h.Authorization = auth.sapisidAuthDrive;
  return h;
}

// --- List / export ---------------------------------------------------------

/**
 * List Google Docs (and plain text) the user can open read-only.
 */
export async function listDocs({ pageSize = 25, pageToken = null, q = null } = {}) {
  const auth = await resolveAuth();
  const query =
    q ||
    "trashed=false and (mimeType='application/vnd.google-apps.document' or mimeType='text/plain')";
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    fields: "nextPageToken,files(id,name,mimeType,modifiedTime,iconLink)",
    q: query,
    orderBy: "modifiedTime desc",
    supportsAllDrives: "false",
  });
  if (pageToken) params.set("pageToken", pageToken);

  const url = `https://www.googleapis.com/drive/v3/files?${params}`;
  const headers =
    auth.kind === "oauth" ? oauthHeaders(auth.token) : sessionApiHeaders(auth);

  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers,
  });
  const text = await res.text();
  await audit({
    channel: "googleapis",
    method: "GET",
    url,
    purpose: "drive.list",
    requestMeta: { bytes: 0, auth: auth.kind },
    responseMeta: { status: res.status, bytes: bytesOf(text) },
    error: res.ok ? null : text.slice(0, 200),
  });

  if (!res.ok) {
    if (auth.kind === "session") {
      const err = new Error(
        `Could not list Drive files via browser session (HTTP ${res.status}). ` +
          `Paste a Google Docs URL instead — export still works with your login. ` +
          `Or open the Doc in a tab and use Import from URL.`
      );
      err.code = "DRIVE_LIST_SESSION_FAILED";
      err.status = res.status;
      throw err;
    }
    throw new Error(`Drive list failed: ${res.status}`);
  }
  return JSON.parse(text);
}

/**
 * Export a file as plain text — preferred path to avoid local format parsing.
 * Session mode uses Docs/Drive web export (same as File → Download → Plain text).
 * OAuth mode uses Drive API export. Read-only; never updates metadata.
 */
export async function exportCvPlainText(fileId, { name = null } = {}) {
  if (!fileId) throw new Error("fileId required");
  const auth = await resolveAuth();

  if (auth.kind === "session") {
    return exportViaSession(fileId, { name });
  }
  return exportViaOAuth(fileId, { name, token: auth.token });
}

async function exportViaSession(fileId, { name }) {
  // 1) Google Doc → plain text export (consumer Drive/Docs; uses session cookies)
  const docExportUrl = `https://docs.google.com/document/d/${encodeURIComponent(
    fileId
  )}/export?format=txt`;
  let content = "";
  let usedUrl = docExportUrl;
  let mimeType = DOC_MIME;
  let fileName = name || "Google Doc";

  {
    const res = await fetch(docExportUrl, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      headers: { Accept: "text/plain,text/html,*/*" },
    });
    const body = await res.text();
    const ct = res.headers.get("content-type") || "";
    await audit({
      channel: "googleapis",
      method: "GET",
      url: docExportUrl,
      purpose: "drive.export.session",
      requestMeta: { auth: "session" },
      responseMeta: {
        status: res.status,
        bytes: bytesOf(body),
        contentType: ct,
        finalHost: safeHost(res.url),
      },
      error: res.ok ? null : body.slice(0, 200),
    });

    if (res.ok && !looksLikeHtmlNotPlainText(body, ct) && !looksLikeGoogleLoginHtml(body)) {
      content = body;
    } else if (/accounts\.google\.com/i.test(res.url || "")) {
      const err = new Error(
        "Google session expired or not signed in. Open drive.google.com, sign in, then retry."
      );
      err.code = "GOOGLE_SESSION_REQUIRED";
      throw err;
    }
  }

  // 2) Fallback: Drive "uc" download (works for some uploaded .txt files)
  if (!content) {
    const ucUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
      fileId
    )}`;
    usedUrl = ucUrl;
    const res = await fetch(ucUrl, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      headers: { Accept: "text/plain,text/html,*/*" },
    });
    const body = await res.text();
    const ct = res.headers.get("content-type") || "";
    await audit({
      channel: "googleapis",
      method: "GET",
      url: ucUrl,
      purpose: "drive.download.session",
      requestMeta: { auth: "session" },
      responseMeta: {
        status: res.status,
        bytes: bytesOf(body),
        contentType: ct,
        finalHost: safeHost(res.url),
      },
      error: res.ok ? null : body.slice(0, 200),
    });

    if (res.ok && !looksLikeHtmlNotPlainText(body, ct) && !looksLikeGoogleLoginHtml(body)) {
      content = body;
      mimeType = ct.includes("text") ? ct.split(";")[0] : "text/plain";
    }
  }

  // 3) Last resort: Drive API + SAPISIDHASH (metadata + export)
  if (!content) {
    const api = await trySessionApiExport(fileId);
    if (api) {
      content = api.content;
      mimeType = api.mimeType || mimeType;
      fileName = name || api.name || fileName;
    }
  }

  if (!content?.trim()) {
    const err = new Error(
      "Could not read that file with your browser Google session. " +
        "Confirm you can open it at docs.google.com while signed in, " +
        "or paste the Docs URL after opening the document once."
    );
    err.code = "GOOGLE_EXPORT_FAILED";
    throw err;
  }

  // Best-effort title from content-disposition is unavailable; keep provided name
  return persistCv({
    fileId,
    name: fileName,
    mimeType,
    content,
    source: "google-session",
    note: `session export · ${usedUrl.includes("export") ? "docs.export" : "drive"}`,
  });
}

async function trySessionApiExport(fileId) {
  const auth = {
    kind: "session",
    sapisidAuthApi: await buildSapisidAuth("https://www.googleapis.com"),
    sapisidAuthDrive: await buildSapisidAuth("https://drive.google.com"),
  };
  if (!auth.sapisidAuthApi && !auth.sapisidAuthDrive) return null;

  const headers = sessionApiHeaders(auth);
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?fields=id,name,mimeType,modifiedTime`;
  const metaRes = await fetch(metaUrl, { credentials: "include", headers });
  const metaText = await metaRes.text();
  await audit({
    channel: "googleapis",
    method: "GET",
    url: metaUrl,
    purpose: "drive.meta.session",
    responseMeta: { status: metaRes.status, bytes: bytesOf(metaText) },
    error: metaRes.ok ? null : metaText.slice(0, 200),
  });
  if (!metaRes.ok) return null;
  const meta = JSON.parse(metaText);

  let content = "";
  if (meta.mimeType === DOC_MIME) {
    const exportUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}/export?mimeType=${encodeURIComponent("text/plain")}`;
    const res = await fetch(exportUrl, { credentials: "include", headers });
    content = await res.text();
    await audit({
      channel: "googleapis",
      method: "GET",
      url: exportUrl,
      purpose: "drive.export.session.api",
      responseMeta: { status: res.status, bytes: bytesOf(content) },
      error: res.ok ? null : content.slice(0, 200),
    });
    if (!res.ok || looksLikeHtmlNotPlainText(content, res.headers.get("content-type"))) {
      return null;
    }
  } else if (meta.mimeType?.startsWith(TEXT_MIME_PREFIX)) {
    const dl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?alt=media`;
    const res = await fetch(dl, { credentials: "include", headers });
    content = await res.text();
    await audit({
      channel: "googleapis",
      method: "GET",
      url: dl,
      purpose: "drive.download.session.api",
      responseMeta: { status: res.status, bytes: bytesOf(content) },
      error: res.ok ? null : content.slice(0, 200),
    });
    if (!res.ok) return null;
  } else {
    return null;
  }

  return { content, name: meta.name, mimeType: meta.mimeType, modifiedTime: meta.modifiedTime };
}

async function exportViaOAuth(fileId, { name, token }) {
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?fields=id,name,mimeType,modifiedTime`;
  const metaRes = await fetch(metaUrl, {
    headers: oauthHeaders(token),
  });
  const metaText = await metaRes.text();
  await audit({
    channel: "googleapis",
    method: "GET",
    url: metaUrl,
    purpose: "drive.meta",
    responseMeta: { status: metaRes.status, bytes: bytesOf(metaText) },
    error: metaRes.ok ? null : metaText.slice(0, 200),
  });
  if (!metaRes.ok) throw new Error(`Drive meta failed: ${metaRes.status}`);
  const meta = JSON.parse(metaText);

  let content = "";
  if (meta.mimeType === DOC_MIME) {
    const exportUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}/export?mimeType=${encodeURIComponent("text/plain")}`;
    const res = await fetch(exportUrl, { headers: oauthHeaders(token) });
    content = await res.text();
    await audit({
      channel: "googleapis",
      method: "GET",
      url: exportUrl,
      purpose: "drive.export",
      responseMeta: { status: res.status, bytes: bytesOf(content) },
      error: res.ok ? null : content.slice(0, 200),
    });
    if (!res.ok) throw new Error(`Drive export failed: ${res.status}`);
  } else if (meta.mimeType === "text/plain" || meta.mimeType?.startsWith(TEXT_MIME_PREFIX)) {
    const exportUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?alt=media`;
    const res = await fetch(exportUrl, { headers: oauthHeaders(token) });
    content = await res.text();
    await audit({
      channel: "googleapis",
      method: "GET",
      url: exportUrl,
      purpose: "drive.download",
      responseMeta: { status: res.status, bytes: bytesOf(content) },
      error: res.ok ? null : content.slice(0, 200),
    });
    if (!res.ok) throw new Error(`Drive download failed: ${res.status}`);
  } else {
    throw new Error(
      `Unsupported mime type ${meta.mimeType}. Open as Google Doc or save plain text on Drive first.`
    );
  }

  return persistCv({
    fileId: meta.id,
    name: name || meta.name,
    mimeType: meta.mimeType,
    modifiedTime: meta.modifiedTime,
    content,
    source: "google-oauth",
    note: `oauth · file ${meta.id}`,
  });
}

async function persistCv({ fileId, name, mimeType, modifiedTime, content, source, note }) {
  const cv = await saveCv({
    id: "current",
    source: source || "google-drive",
    fileId,
    name: name || "Google Doc",
    mimeType: mimeType || DOC_MIME,
    modifiedTime: modifiedTime || null,
    text: content,
    fetchedAt: nowIso(),
  });

  // Explicit CV import for applications → allowlist PII + prefill empty profile slots
  try {
    const found = findPiiCandidates(content);
    if (found.length) {
      await approvePiiValues(found.map((c) => ({ value: c.value, type: `cv:${c.type}` })));
    }
  } catch {
    /* best-effort */
  }
  try {
    const extracted = extractContactFromCv(content);
    if (Object.keys(extracted).length) {
      const existing = (await getProfile()) || {};
      const merged = { ...existing };
      let changed = false;
      for (const [k, v] of Object.entries(extracted)) {
        if (!v) continue;
        if (!merged[k] || !String(merged[k]).trim()) {
          merged[k] = v;
          changed = true;
        }
      }
      if (changed) await setProfile(merged);
    }
  } catch {
    /* best-effort */
  }

  await audit({
    purpose: "pipeline.setCv",
    channel: "local",
    note: note || `${source} · ${content.length} chars · file ${fileId}`,
  });

  return {
    id: cv.id,
    name: cv.name,
    fileId: cv.fileId,
    text: content,
    modifiedTime: cv.modifiedTime,
    chars: content.length,
    source: cv.source,
  };
}

/**
 * Parse a Google Docs / Drive URL for file id.
 */
export function parseDocsUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:document|file|presentation|spreadsheets)\/d\/([^/]+)/);
    if (m) return m[1];
    if (u.searchParams.get("id")) return u.searchParams.get("id");
    // drive.google.com/open?id=
    if (u.hostname.includes("drive.google.com")) {
      const open = u.searchParams.get("id");
      if (open) return open;
      const filePath = u.pathname.match(/\/file\/d\/([^/]+)/);
      if (filePath) return filePath[1];
    }
  } catch {
    /* */
  }
  return null;
}
