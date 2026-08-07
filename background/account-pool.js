/**
 * X/Twitter account pool for Grok session rotation.
 * Accounts are uniquely keyed by username (screen_name) when resolvable,
 * otherwise by auth_token fingerprint. Mirrors rotation ideas from likewatcher;
 * secrets stay encrypted in Firefox.
 */

import {
  listAccountsPublic,
  getAccountSecrets,
  touchAccount,
  upsertAccountByUsername,
  rekeyAccountsByUsername,
  removeAccount,
  isUnlocked,
} from "./secure-store.js";
import { audit } from "./audit-log.js";
import { bytesOf } from "../lib/util.js";

const X_BEARER =
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

/**
 * Resolve @username for a session via verify_credentials (read-only).
 * @returns {Promise<{ username: string|null, userId: string|null, name: string|null }>}
 */
export async function resolveXUsername({ authToken, ct0, userAgent }) {
  if (!authToken || !ct0) return { username: null, userId: null, name: null };
  const url = "https://api.x.com/1.1/account/verify_credentials.json?skip_status=true&include_entities=false";
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        authorization: X_BEARER,
        "x-csrf-token": ct0,
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes",
        "x-twitter-client-language": "en",
        cookie: `auth_token=${authToken}; ct0=${ct0}`,
        referer: "https://x.com/",
        origin: "https://x.com",
        "user-agent":
          userAgent ||
          "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
      },
    });
    const text = await res.text();
    await audit({
      channel: "x.com",
      method: "GET",
      url,
      purpose: "accounts.verifyCredentials",
      requestMeta: { bytes: 0 },
      responseMeta: { status: res.status, bytes: bytesOf(text) },
      error: res.ok ? null : text.slice(0, 200),
    });
    if (!res.ok) return { username: null, userId: null, name: null };
    const j = JSON.parse(text);
    const username = j.screen_name ? String(j.screen_name).replace(/^@/, "") : null;
    return {
      username,
      userId: j.id_str ? String(j.id_str) : j.id != null ? String(j.id) : null,
      name: j.name || null,
    };
  } catch (err) {
    await audit({
      channel: "x.com",
      purpose: "accounts.verifyCredentials",
      error: err.message,
    });
    return { username: null, userId: null, name: null };
  }
}

/**
 * Import auth_token + ct0 from the browser's cookie jar for x.com / twitter.com.
 * Dedupes by username (preferred) or auth_token.
 */
export async function importBrowserXSessions() {
  if (!isUnlocked()) throw new Error("Vault locked");
  const hosts = [".x.com", "x.com", ".twitter.com", "twitter.com"];
  const found = [];

  for (const host of hosts) {
    try {
      const cookies = await browser.cookies.getAll({ domain: host });
      const auth = cookies.find((c) => c.name === "auth_token");
      const ct0 = cookies.find((c) => c.name === "ct0");
      if (auth?.value && ct0?.value) {
        found.push({
          host,
          authToken: auth.value,
          ct0: ct0.value,
        });
      }
    } catch {
      /* cookie permission may fail for some domains */
    }
  }

  // Dedupe by auth token (same session appears under multiple hosts)
  const byToken = new Map();
  for (const f of found) byToken.set(f.authToken, f);

  const added = [];
  const updated = [];
  for (const f of byToken.values()) {
    const identity = await resolveXUsername({
      authToken: f.authToken,
      ct0: f.ct0,
    });
    const label = identity.username
      ? `@${identity.username}`
      : `browser:${f.host}`;
    const row = await upsertAccountByUsername({
      label,
      username: identity.username,
      userId: identity.userId,
      authToken: f.authToken,
      ct0: f.ct0,
    });
    if (row._upsert === "updated") updated.push(row);
    else added.push(row);
  }

  // Collapse any legacy UUID rows onto x:username keys
  let rekey = { rekeyed: 0, deduped: 0 };
  try {
    rekey = await rekeyAccountsByUsername(resolveXUsername);
  } catch {
    /* best-effort */
  }

  await audit({
    purpose: "accounts.importBrowserX",
    channel: "local",
    note: `Imported ${added.length} new, updated ${updated.length} (found ${byToken.size} session(s)); rekey ${rekey.rekeyed} deduped ${rekey.deduped}`,
  });
  return {
    added,
    updated,
    totalFound: byToken.size,
    rekeyed: rekey.rekeyed,
    deduped: rekey.deduped,
  };
}

/**
 * Public account list. Best-effort rekey of legacy UUID rows to x:username so the
 * pool is always uniquely keyed by screen_name when resolvable.
 */
export async function listPool({ rekey = false } = {}) {
  if (rekey && isUnlocked()) {
    try {
      await rekeyAccountsByUsername(resolveXUsername);
    } catch {
      /* best-effort */
    }
  }
  return listAccountsPublic();
}

/** Force re-resolve usernames and collapse duplicate pool entries. */
export async function rekeyPool() {
  if (!isUnlocked()) throw new Error("Vault locked");
  const result = await rekeyAccountsByUsername(resolveXUsername);
  await audit({
    purpose: "accounts.rekey",
    channel: "local",
    note: `rekeyed ${result.rekeyed}, deduped ${result.deduped}`,
  });
  return result;
}

/**
 * Add or update pool account. Resolves username and keys uniquely by it.
 */
export async function addPoolAccount(data) {
  const authToken = data.authToken || data.auth_token;
  const ct0 = data.ct0;
  if (!authToken || !ct0) throw new Error("authToken and ct0 required");

  let username = data.username ? String(data.username).replace(/^@/, "") : null;
  let userId = data.userId || null;
  if (!username) {
    const identity = await resolveXUsername({
      authToken,
      ct0,
      userAgent: data.userAgent,
    });
    username = identity.username;
    userId = identity.userId || userId;
  }

  const label =
    data.label ||
    (username ? `@${username}` : undefined);

  const row = await upsertAccountByUsername({
    label,
    username,
    userId,
    authToken,
    ct0,
    userAgent: data.userAgent,
  });

  await audit({
    purpose: "accounts.add",
    channel: "local",
    accountId: row.id,
    note: `${row._upsert || "added"} · ${row.username || row.label}`,
  });
  return row;
}

export async function removePoolAccount(id) {
  await removeAccount(id);
  await audit({ purpose: "accounts.remove", channel: "local", accountId: id });
}

/**
 * Pick next usable account (round-robin by lastUsedAt, skip disabled / cooling).
 */
export async function pickAccount() {
  const publicList = (await listAccountsPublic()).filter((a) => a.enabled !== false);
  if (!publicList.length) return null;

  const now = Date.now();
  const scored = [];
  for (const a of publicList) {
    const full = await getAccountSecrets(a.id);
    if (!full?.authToken || !full?.ct0) continue;
    const rl = full.rateLimit;
    if (rl?.resetAt && now < rl.resetAt && (rl.remaining ?? 0) <= 0) continue;
    scored.push(full);
  }
  if (!scored.length) return null;

  scored.sort((a, b) => {
    const ta = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const tb = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return ta - tb;
  });
  return scored[0];
}

export async function markAccountResult(accountId, { ok, status, rateLimit, error }) {
  const patch = {
    lastError: ok ? null : String(error || status || "error"),
    stats: undefined,
  };
  const full = await getAccountSecrets(accountId);
  const stats = { ...(full?.stats || {}) };
  stats.calls = (stats.calls || 0) + 1;
  if (ok) stats.ok = (stats.ok || 0) + 1;
  else stats.fail = (stats.fail || 0) + 1;
  patch.stats = stats;
  if (rateLimit) patch.rateLimit = rateLimit;
  await touchAccount(accountId, patch);
}

/**
 * Signal to UI that more accounts / backends are needed.
 */
export function needMoreAccountsError(reason) {
  const err = new Error(
    reason ||
      "LLM backends unavailable. Add an OpenAI API key (automatic Grok fallback), an xAI key, or more Twitter/X accounts in Options."
  );
  err.code = "NEED_MORE_ACCOUNTS";
  return err;
}
