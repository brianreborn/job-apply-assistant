/** Shared utilities for JobApply Assistant */

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Safe JSON parse; returns fallback on failure. */
export function tryJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Extract first JSON object/array from model text (handles markdown fences).
 */
export function extractJson(text) {
  if (!text || typeof text !== "string") return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text.trim();
  const direct = tryJson(candidate);
  if (direct !== null) return direct;
  const startObj = candidate.indexOf("{");
  const startArr = candidate.indexOf("[");
  let start = -1;
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) start = startObj;
  else if (startArr >= 0) start = startArr;
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && ch === close) {
        return tryJson(candidate.slice(start, i + 1));
      }
    }
  }
  return null;
}

export function truncate(str, max = 200) {
  if (!str) return "";
  const s = String(str);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function bytesOf(str) {
  return new TextEncoder().encode(str || "").length;
}

/** Normalize host for audit channel labels. */
export function channelFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("x.ai")) return "api.x.ai";
    if (u.hostname.includes("x.com") || u.hostname.includes("twitter.com")) return "x.com";
    if (u.hostname.includes("googleapis.com") || u.hostname.includes("google.com"))
      return "googleapis";
    return u.hostname;
  } catch {
    return "unknown";
  }
}

export function redactUrl(url) {
  try {
    const u = new URL(url);
    // Drop query secrets
    const keep = ["pageSize", "q", "mimeType", "fields", "pageToken"];
    const params = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (keep.includes(k)) params.set(k, v);
      else if (k === "access_token" || k === "key" || k === "client_secret") params.set(k, "[redacted]");
    }
    const qs = params.toString();
    return `${u.origin}${u.pathname}${qs ? "?" + qs : ""}`;
  } catch {
    return "[invalid-url]";
  }
}

export function normalizeLabel(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function scoreLabelMatch(a, b) {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.75;
  const ta = new Set(na.split(" ").filter(Boolean));
  const tb = new Set(nb.split(" ").filter(Boolean));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}
