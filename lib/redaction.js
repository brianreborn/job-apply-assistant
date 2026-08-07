/**
 * Local PII detection for the privacy gate.
 * Flags candidates; does not send anything itself.
 */

const PATTERNS = [
  { type: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  {
    type: "phone",
    re: /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}\b/g,
  },
  {
    type: "ssn_like",
    re: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  },
  {
    type: "url_personal",
    re: /https?:\/\/(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com|bitbucket\.org)\/[^\s)]+/gi,
  },
  {
    type: "street_address",
    re: /\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Lane|Ln|Dr|Drive|Ct|Court)\b/gi,
  },
  {
    type: "dob_like",
    re: /\b(?:0?[1-9]|1[0-2])[\/\-.](?:0?[1-9]|[12]\d|3[01])[\/\-.](?:19|20)\d{2}\b/g,
  },
];

/**
 * @param {string} text
 * @returns {{ type: string, value: string, index: number }[]}
 */
export function findPiiCandidates(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();
  for (const { type, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(text)) !== null) {
      const value = m[0];
      // Drop short phone false positives
      if (type === "phone" && value.replace(/\D/g, "").length < 10) continue;
      const key = `${type}:${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ type, value, index: m.index });
    }
  }
  return found;
}

/**
 * Replace unapproved PII with placeholders.
 * @param {string} text
 * @param {Set<string>|string[]} allowValues  exact values allowed to remain
 * @returns {{ text: string, redacted: {type,value,placeholder}[], remaining: {type,value}[] }}
 */
export function redactUnapproved(text, allowValues = []) {
  const allow = new Set(
    [...allowValues].map((v) => String(v).toLowerCase().trim()).filter(Boolean)
  );
  const candidates = findPiiCandidates(text);
  const redacted = [];
  const remaining = [];
  let out = text;
  // Replace from end so indices stay valid for original; safer: replace unique values
  const byValue = new Map();
  for (const c of candidates) {
    const key = c.value.toLowerCase();
    if (allow.has(key)) {
      remaining.push({ type: c.type, value: c.value, status: "allowed" });
      continue;
    }
    if (!byValue.has(key)) byValue.set(key, c);
  }
  let i = 0;
  for (const [key, c] of byValue) {
    const placeholder = `[REDACTED_${c.type.toUpperCase()}_${++i}]`;
    const re = new RegExp(escapeRe(c.value), "gi");
    out = out.replace(re, placeholder);
    redacted.push({ type: c.type, value: c.value, placeholder });
  }
  return { text: out, redacted, remaining };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build allow set from profile fields + explicit allowlist entries.
 */
export function allowSetFromProfile(profile = {}, allowlist = []) {
  const vals = [];
  for (const k of [
    "fullName",
    "email",
    "phone",
    "address",
    "city",
    "state",
    "zip",
    "country",
    "linkedin",
    "github",
    "website",
  ]) {
    if (profile[k]) vals.push(profile[k]);
  }
  for (const entry of allowlist) {
    if (typeof entry === "string") vals.push(entry);
    else if (entry?.value) vals.push(entry.value);
  }
  return vals;
}
