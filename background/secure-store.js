/**
 * IndexedDB + Web Crypto secure store for JobApply Assistant.
 * Secrets (X cookies, OAuth tokens, xAI key) encrypted at rest with passphrase-derived key.
 */

import { uuid, nowIso } from "../lib/util.js";

const DB_NAME = "JobApplyDB";
const DB_VERSION = 1;
const STORES = ["meta", "accounts", "audit", "cvs", "applications", "pii_allowlist", "settings"];

let dbPromise = null;
/** @type {CryptoKey|null} */
let sessionKey = null;
let unlocked = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: "id" });
          if (name === "audit") store.createIndex("by_ts", "ts", { unique: false });
          if (name === "applications") store.createIndex("by_updated", "updatedAt", { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode = "readonly") {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

export async function idbGet(store, id) {
  const s = await tx(store);
  return new Promise((resolve, reject) => {
    const r = s.get(id);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}

export async function idbPut(store, value) {
  const s = await tx(store, "readwrite");
  return new Promise((resolve, reject) => {
    const r = s.put(value);
    r.onsuccess = () => resolve(value);
    r.onerror = () => reject(r.error);
  });
}

export async function idbDelete(store, id) {
  const s = await tx(store, "readwrite");
  return new Promise((resolve, reject) => {
    const r = s.delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function idbGetAll(store) {
  const s = await tx(store);
  return new Promise((resolve, reject) => {
    const r = s.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

export async function idbClear(store) {
  const s = await tx(store, "readwrite");
  return new Promise((resolve, reject) => {
    const r = s.clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// --- Crypto ---

function b64encode(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptJson(obj) {
  if (!sessionKey) throw new Error("Vault locked");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sessionKey, plain);
  return { iv: b64encode(iv), data: b64encode(cipher) };
}

export async function decryptJson(payload) {
  if (!sessionKey) throw new Error("Vault locked");
  if (!payload?.iv || !payload?.data) return null;
  const iv = b64decode(payload.iv);
  const data = b64decode(payload.data);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sessionKey, data);
  return JSON.parse(new TextDecoder().decode(plain));
}

export async function isSetup() {
  const meta = await idbGet("meta", "vault");
  return Boolean(meta?.salt && meta?.verifier);
}

export function isUnlocked() {
  return unlocked && !!sessionKey;
}

export async function setupPassphrase(passphrase) {
  if (!passphrase || passphrase.length < 8) {
    throw new Error("Passphrase must be at least 8 characters");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  sessionKey = await deriveKey(passphrase, salt);
  const verifier = await encryptJson({ ok: true, createdAt: nowIso() });
  await idbPut("meta", {
    id: "vault",
    salt: b64encode(salt),
    verifier,
    createdAt: nowIso(),
  });
  unlocked = true;
  return { unlocked: true, setup: true };
}

export async function unlock(passphrase) {
  const meta = await idbGet("meta", "vault");
  if (!meta?.salt || !meta?.verifier) throw new Error("Vault not set up");
  const salt = b64decode(meta.salt);
  sessionKey = await deriveKey(passphrase, salt);
  try {
    const v = await decryptJson(meta.verifier);
    if (!v?.ok) throw new Error("bad");
  } catch {
    sessionKey = null;
    unlocked = false;
    throw new Error("Incorrect passphrase");
  }
  unlocked = true;
  return { unlocked: true };
}

export function lock() {
  sessionKey = null;
  unlocked = false;
}

export async function sessionStatus() {
  return {
    setup: await isSetup(),
    unlocked: isUnlocked(),
  };
}

// --- Encrypted settings helpers ---

const SETTINGS_ID = "app";

export async function getSettings() {
  const row = await idbGet("settings", SETTINGS_ID);
  if (!row) {
    return {
      googleClientId: "",
      googleSessionEnabled: false,
      currentAppId: null,
      auditRetentionDays: 90,
      model: "grok-3",
      openaiModel: "gpt-4o-mini",
      geminiModel: "gemini-2.0-flash",
      msModel: "gpt-4o-mini",
      msEndpoint: "",
      combinePrompts: true,
    };
  }
  const publicPart = {
    googleClientId: row.googleClientId || "",
    googleSessionEnabled: Boolean(row.googleSessionEnabled),
    currentAppId: row.currentAppId || null,
    auditRetentionDays: row.auditRetentionDays ?? 90,
    model: row.model || "grok-3",
    openaiModel: row.openaiModel || "gpt-4o-mini",
    geminiModel: row.geminiModel || "gemini-2.0-flash",
    msModel: row.msModel || "gpt-4o-mini",
    msEndpoint: row.msEndpoint || "",
    combinePrompts: row.combinePrompts !== false,
    hasXaiKey: false,
    hasOpenaiKey: false,
    hasGeminiKey: false,
    hasMsKey: false,
    hasGoogleTokens: false,
  };
  if (isUnlocked() && row.secrets) {
    try {
      const secrets = await decryptJson(row.secrets);
      publicPart.hasXaiKey = Boolean(secrets?.xaiApiKey);
      publicPart.hasOpenaiKey = Boolean(secrets?.openaiApiKey);
      publicPart.hasGeminiKey = Boolean(secrets?.geminiApiKey);
      publicPart.hasMsKey = Boolean(secrets?.msApiKey);
      publicPart.hasGoogleTokens = Boolean(secrets?.googleTokens?.access_token);
      publicPart._secrets = secrets; // internal only; strip before UI if needed
    } catch {
      /* ignore */
    }
  }
  return publicPart;
}

export async function getSecrets() {
  if (!isUnlocked()) throw new Error("Vault locked");
  const row = await idbGet("settings", SETTINGS_ID);
  if (!row?.secrets) return {};
  return (await decryptJson(row.secrets)) || {};
}

export async function patchSettings(patch, secretPatch) {
  const row = (await idbGet("settings", SETTINGS_ID)) || { id: SETTINGS_ID };
  if (patch) {
    if ("googleClientId" in patch) row.googleClientId = patch.googleClientId;
    if ("googleSessionEnabled" in patch) row.googleSessionEnabled = Boolean(patch.googleSessionEnabled);
    if ("currentAppId" in patch) row.currentAppId = patch.currentAppId || null;
    if ("auditRetentionDays" in patch) row.auditRetentionDays = patch.auditRetentionDays;
    if ("model" in patch) row.model = patch.model;
    if ("openaiModel" in patch) row.openaiModel = patch.openaiModel;
    if ("geminiModel" in patch) row.geminiModel = patch.geminiModel;
    if ("msModel" in patch) row.msModel = patch.msModel;
    if ("msEndpoint" in patch) row.msEndpoint = patch.msEndpoint;
    if ("combinePrompts" in patch) row.combinePrompts = patch.combinePrompts;
  }
  if (secretPatch) {
    if (!isUnlocked()) throw new Error("Vault locked");
    const existing = row.secrets ? (await decryptJson(row.secrets)) || {} : {};
    const merged = { ...existing, ...secretPatch };
    // allow null to clear
    for (const [k, v] of Object.entries(secretPatch)) {
      if (v === null) delete merged[k];
    }
    row.secrets = await encryptJson(merged);
  }
  row.updatedAt = nowIso();
  await idbPut("settings", row);
  return getSettings();
}

// --- Accounts ---

/** Normalize X screen_name for unique keys. */
export function normalizeUsername(u) {
  if (!u) return null;
  return String(u).trim().replace(/^@/, "").toLowerCase() || null;
}

export async function listAccountsPublic() {
  const rows = await idbGetAll("accounts");
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    username: r.username || null,
    userId: r.userId || null,
    enabled: r.enabled !== false,
    lastUsedAt: r.lastUsedAt || null,
    lastError: r.lastError || null,
    stats: r.stats || {},
    hasSecrets: Boolean(r.payload),
  }));
}

/**
 * Add or update an X account, guaranteeing 1-to-1 unique keying by username.
 * Canonical IndexedDB id is always `x:${lowercase_username}` when username is known.
 * Re-import / re-add with the same @user updates cookies in place and deletes
 * any legacy UUID rows for that user or auth_token.
 */
export async function upsertAccountByUsername({
  label,
  authToken,
  ct0,
  userAgent,
  username,
  userId,
}) {
  if (!isUnlocked()) throw new Error("Vault locked");
  if (!authToken || !ct0) throw new Error("authToken and ct0 required");

  const uname = normalizeUsername(username);
  // Preserve original casing for display when provided; fall back to uname
  const displayName = uname
    ? String(username || uname).trim().replace(/^@/, "") || uname
    : null;

  // Find all matching rows to deduplicate and migrate onto canonical id `x:${uname}`
  const rows = await idbGetAll("accounts");
  const matching = [];
  const seenIds = new Set();
  const pushMatch = (r) => {
    if (!r || seenIds.has(r.id)) return;
    seenIds.add(r.id);
    matching.push(r);
  };
  for (const r of rows) {
    if (uname && (normalizeUsername(r.username) === uname || r.id === `x:${uname}`)) {
      pushMatch(r);
      continue;
    }
    if (authToken && r.payload) {
      try {
        const sec = await decryptJson(r.payload);
        if (sec?.authToken === authToken) pushMatch(r);
      } catch {
        /* */
      }
    }
  }

  const payload = await encryptJson({
    authToken,
    ct0,
    userAgent:
      userAgent ||
      "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
  });

  // Prefer stable username key; only fall back to prior id / uuid when screen_name
  // could not be resolved (verify_credentials failed).
  const canonicalId = uname
    ? `x:${uname}`
    : matching.find((m) => m.id?.startsWith?.("x:"))?.id ||
      matching[0]?.id ||
      uuid();

  // Prefer the row already on the canonical id (or with best stats) as the base
  const existing =
    matching.find((m) => m.id === canonicalId) ||
    matching.find((m) => normalizeUsername(m.username) === uname) ||
    matching[0] ||
    null;

  // Merge stats across duplicates before delete
  const mergedStats = { ...(existing?.stats || {}) };
  for (const m of matching) {
    if (m === existing) continue;
    const s = m.stats || {};
    mergedStats.calls = (mergedStats.calls || 0) + (s.calls || 0);
    mergedStats.ok = (mergedStats.ok || 0) + (s.ok || 0);
    mergedStats.fail = (mergedStats.fail || 0) + (s.fail || 0);
  }

  // Clean up any stale duplicate rows for this username or auth token
  for (const m of matching) {
    if (m.id !== canonicalId) {
      await idbDelete("accounts", m.id);
    }
  }

  const row = {
    ...(existing || {}),
    id: canonicalId,
    label:
      label ||
      (displayName ? `@${displayName}` : null) ||
      existing?.label ||
      `account-${canonicalId.slice(0, 8)}`,
    username: displayName || existing?.username || null,
    userId: userId || existing?.userId || null,
    payload,
    enabled: existing ? existing.enabled !== false : true,
    stats: mergedStats,
    lastError: existing?.lastError || null,
    rateLimit: existing?.rateLimit || null,
    lastUsedAt: existing?.lastUsedAt || null,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };

  await idbPut("accounts", row);
  const pub = (await listAccountsPublic()).find((a) => a.id === canonicalId);
  return { ...pub, _upsert: existing ? "updated" : "added" };
}

/**
 * Re-resolve usernames for accounts missing a stable `x:username` id and collapse
 * duplicates. Safe to call after unlock / import; never deletes the only copy of secrets.
 * @returns {Promise<{ rekeyed: number, deduped: number }>}
 */
export async function rekeyAccountsByUsername(resolveUsernameFn) {
  if (!isUnlocked()) throw new Error("Vault locked");
  if (typeof resolveUsernameFn !== "function") {
    return { rekeyed: 0, deduped: 0 };
  }
  const rows = await idbGetAll("accounts");
  let rekeyed = 0;
  let deduped = 0;
  for (const r of rows) {
    // Skip rows already removed by a prior merge in this pass
    const stillThere = await idbGet("accounts", r.id);
    if (!stillThere) continue;

    const uname = normalizeUsername(stillThere.username || r.username);
    const needsResolve = !uname || !String(stillThere.id || "").startsWith("x:");
    if (!needsResolve) continue;
    let secrets;
    try {
      secrets = stillThere.payload ? await decryptJson(stillThere.payload) : null;
    } catch {
      continue;
    }
    if (!secrets?.authToken || !secrets?.ct0) continue;
    let username = uname;
    let userId = stillThere.userId || null;
    if (!username) {
      try {
        const identity = await resolveUsernameFn({
          authToken: secrets.authToken,
          ct0: secrets.ct0,
          userAgent: secrets.userAgent,
        });
        username = identity?.username || null;
        userId = identity?.userId || userId;
      } catch {
        continue;
      }
    }
    if (!username) continue;
    const beforeCount = (await idbGetAll("accounts")).length;
    await upsertAccountByUsername({
      label: stillThere.label,
      authToken: secrets.authToken,
      ct0: secrets.ct0,
      userAgent: secrets.userAgent,
      username,
      userId,
    });
    rekeyed += 1;
    const afterCount = (await idbGetAll("accounts")).length;
    if (afterCount < beforeCount) deduped += beforeCount - afterCount;
  }
  return { rekeyed, deduped };
}

export async function removeAccount(id) {
  await idbDelete("accounts", id);
}

export async function getAccountSecrets(id) {
  if (!isUnlocked()) throw new Error("Vault locked");
  const row = await idbGet("accounts", id);
  if (!row?.payload) return null;
  const secrets = await decryptJson(row.payload);
  return { ...row, ...secrets };
}

export async function touchAccount(id, patch = {}) {
  const row = await idbGet("accounts", id);
  if (!row) return;
  // Don't let patch wipe username/id accidentally with undefined
  const clean = { ...patch };
  for (const k of Object.keys(clean)) {
    if (clean[k] === undefined) delete clean[k];
  }
  Object.assign(row, clean, { lastUsedAt: nowIso() });
  await idbPut("accounts", row);
}

// --- CVs / applications / pii ---

export async function saveCv(record) {
  const id = record.id || "current";
  const row = { ...record, id, updatedAt: nowIso() };
  await idbPut("cvs", row);
  return row;
}

export async function getCv(id = "current") {
  return idbGet("cvs", id);
}

export async function deleteCv(id = "current") {
  await idbDelete("cvs", id);
  return true;
}

export async function saveApplication(record) {
  const id = record.id || uuid();
  const row = {
    ...record,
    id,
    updatedAt: nowIso(),
    createdAt: record.createdAt || nowIso(),
  };
  await idbPut("applications", row);
  return row;
}

export async function getApplication(id) {
  return idbGet("applications", id);
}

export async function listApplications() {
  const all = await idbGetAll("applications");
  return all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getPiiAllowlist() {
  const row = await idbGet("pii_allowlist", "default");
  return row?.entries || [];
}

export async function setPiiAllowlist(entries) {
  await idbPut("pii_allowlist", {
    id: "default",
    entries: entries || [],
    updatedAt: nowIso(),
  });
  return entries;
}

export async function getProfile() {
  const row = await idbGet("settings", "profile");
  return row?.data || {};
}

/**
 * Persist application profile. Merges with existing fields so partial saves
 * (e.g. Options only edits name/email) do not wipe sidebar contact slots.
 * Empty string or null clears that key.
 */
export async function setProfile(data) {
  const existing = (await getProfile()) || {};
  const next = { ...existing };
  for (const [k, value] of Object.entries(data || {})) {
    if (value == null) {
      delete next[k];
      continue;
    }
    if (typeof value === "string") {
      const v = value.trim();
      if (!v) delete next[k];
      else next[k] = v;
      continue;
    }
    next[k] = value;
  }
  await idbPut("settings", { id: "profile", data: next, updatedAt: nowIso() });
  // Explicit profile submission for applications → allowlist PII for the Grok gate
  try {
    const entries = await getPiiAllowlist();
    const map = new Map(
      entries.map((e) => [String(e.value || e).toLowerCase(), e])
    );
    for (const [type, value] of Object.entries(next)) {
      if (!value || typeof value !== "string") continue;
      const v = value.trim();
      if (!v) continue;
      map.set(v.toLowerCase(), {
        value: v,
        type: `profile:${type}`,
        approvedAt: nowIso(),
      });
    }
    await setPiiAllowlist([...map.values()]);
  } catch {
    /* best-effort */
  }
  return next;
}
