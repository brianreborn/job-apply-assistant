/**
 * Privacy gate: block outbound LLM payloads that contain unvetted personal info.
 * Explicit application profile data and allowlisted values may pass.
 */

import {
  findPiiCandidates,
  redactUnapproved,
  allowSetFromProfile,
} from "../lib/redaction.js";
import { getPiiAllowlist, getProfile, setPiiAllowlist } from "./secure-store.js";
import { audit } from "./audit-log.js";

/**
 * Prepare text for Grok. If unvetted PII remains and mode is 'block', throws with review payload.
 *
 * @param {string} text
 * @param {{ mode?: 'block'|'redact', extraAllow?: string[] }} opts
 */
export async function gateText(text, opts = {}) {
  const mode = opts.mode || "block";
  const profile = await getProfile();
  const allowlist = await getPiiAllowlist();
  const allow = allowSetFromProfile(profile, [
    ...allowlist,
    ...(opts.extraAllow || []),
  ]);

  const candidates = findPiiCandidates(text);
  const allowSet = new Set(allow.map((v) => String(v).toLowerCase().trim()));
  const unvetted = candidates.filter((c) => !allowSet.has(c.value.toLowerCase()));

  if (unvetted.length === 0) {
    await audit({
      purpose: "pii.gate",
      channel: "local",
      requestMeta: { piiGate: "passed", candidateCount: candidates.length },
    });
    return { text, piiGate: "passed", redacted: [], unvetted: [] };
  }

  if (mode === "redact") {
    const { text: out, redacted } = redactUnapproved(text, allow);
    await audit({
      purpose: "pii.gate",
      channel: "local",
      requestMeta: {
        piiGate: "partial",
        redactedCount: redacted.length,
        types: redacted.map((r) => r.type),
      },
    });
    return { text: out, piiGate: "partial", redacted, unvetted };
  }

  // block mode — do not send
  await audit({
    purpose: "pii.gate",
    channel: "local",
    requestMeta: {
      piiGate: "blocked",
      unvettedCount: unvetted.length,
      types: unvetted.map((u) => u.type),
    },
    error: "Unvetted personal information blocked",
  });

  const err = new Error(
    "Personal information must be vetted before sending to Grok. Review and approve in the side panel."
  );
  err.code = "PII_REVIEW_REQUIRED";
  err.unvetted = unvetted.map((u) => ({ type: u.type, value: u.value }));
  throw err;
}

/**
 * Approve PII values for future outbound prompts (and application use).
 */
export async function approvePiiValues(values) {
  const current = await getPiiAllowlist();
  const map = new Map(
    current.map((e) => [String(e.value || e).toLowerCase(), e])
  );
  for (const v of values || []) {
    const value = typeof v === "string" ? v : v.value;
    const type = typeof v === "string" ? "manual" : v.type || "manual";
    if (!value) continue;
    map.set(value.toLowerCase(), { value, type, approvedAt: new Date().toISOString() });
  }
  const entries = [...map.values()];
  await setPiiAllowlist(entries);
  await audit({
    purpose: "pii.approve",
    channel: "local",
    note: `Approved ${values?.length || 0} value(s)`,
  });
  return entries;
}

export async function scanForReview(parts) {
  const profile = await getProfile();
  const allowlist = await getPiiAllowlist();
  const allow = new Set(
    allowSetFromProfile(profile, allowlist).map((v) => v.toLowerCase())
  );
  const all = [];
  const seen = new Set();
  for (const part of parts) {
    for (const c of findPiiCandidates(part || "")) {
      const k = c.value.toLowerCase();
      if (seen.has(k) || allow.has(k)) continue;
      seen.add(k);
      all.push(c);
    }
  }
  return all;
}
