/**
 * Local heuristic field mapping (used alone or as fallback after Grok).
 * Missing data stays empty — never invents.
 */

import { normalizeLabel, scoreLabelMatch } from "./util.js";

const ALIASES = [
  { keys: ["first name", "firstname", "given name", "fname"], path: "firstName" },
  { keys: ["last name", "lastname", "surname", "family name", "lname"], path: "lastName" },
  { keys: ["full name", "name", "legal name", "applicant name"], path: "fullName" },
  { keys: ["email", "e-mail", "email address"], path: "email" },
  { keys: ["phone", "telephone", "mobile", "cell", "phone number"], path: "phone" },
  { keys: ["city", "town"], path: "city" },
  { keys: ["state", "province", "region"], path: "state" },
  { keys: ["zip", "zip code", "postal", "postal code"], path: "zip" },
  { keys: ["country"], path: "country" },
  { keys: ["address", "street", "street address", "address line 1"], path: "address" },
  { keys: ["address line 2", "address 2", "apt", "suite", "unit", "bldg", "building", "apartment"], path: "address2" },
  { keys: ["linkedin", "linkedin url", "linkedin profile"], path: "linkedin" },
  { keys: ["github", "github url"], path: "github" },
  { keys: ["website", "portfolio", "personal website", "url"], path: "website" },
  { keys: ["cover letter", "coverletter", "letter of interest"], path: "_coverLetter" },
  {
    keys: ["additional information", "additional info", "message", "comments", "why do you want"],
    path: "_coverLetter",
  },
  { keys: ["summary", "professional summary", "about you", "bio"], path: "_summary" },
  { keys: ["skills", "technical skills", "key skills"], path: "_skills" },
  {
    keys: [
      "resume text",
      "cv text",
      "paste resume",
      "paste your resume",
      "resume body",
      "curriculum vitae",
      "full resume",
    ],
    path: "_atsResume",
  },
];

const EXP_PATTERNS = [
  { re: /(?:company|employer|organization|workplace)\s*(?:name)?/i, field: "employer" },
  { re: /(?:job\s*)?title|position|role/i, field: "title" },
  { re: /(?:start|from)\s*(?:date)?|date\s*from|employment\s*start/i, field: "start" },
  { re: /(?:end|to|finish)\s*(?:date)?|date\s*to|employment\s*end/i, field: "end" },
  {
    re: /(?:job\s*)?description|responsibilities|duties|accomplishments|achievements|highlights/i,
    field: "description",
  },
  { re: /(?:work\s*)?location|job\s*location|office/i, field: "location" },
];

const EDU_PATTERNS = [
  { re: /school|university|college|institution/i, field: "school" },
  { re: /degree|qualification/i, field: "degree" },
  { re: /field\s*of\s*study|major|concentration|discipline/i, field: "field" },
  { re: /(?:start|from)\s*(?:date|year)?/i, field: "start" },
  { re: /(?:end|to|graduat|finish)\s*(?:date|year)?|graduation/i, field: "end" },
];

/**
 * Split full name into first/last when possible.
 */
export function splitName(fullName) {
  if (!fullName) return { firstName: "", lastName: "" };
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Build a flat value bag from profile + distilled analysis.
 */
export function buildValueBag({
  profile = {},
  distilled = {},
  coverLetter = "",
  atsResumeText = "",
}) {
  const extracted = distilled.profileFields || {};
  const name = profile.fullName || extracted.fullName || "";
  const { firstName, lastName } = splitName(name);
  const skills = Array.isArray(distilled.skills) ? distilled.skills.join(", ") : "";
  return {
    fullName: name,
    firstName: profile.firstName || firstName,
    lastName: profile.lastName || lastName,
    email: profile.email || extracted.email || "",
    phone: profile.phone || extracted.phone || "",
    address: profile.address || extracted.address || "",
    address2: profile.address2 || extracted.address2 || "",
    city: profile.city || extracted.city || "",
    state: profile.state || extracted.state || "",
    zip: profile.zip || extracted.zip || "",
    country: profile.country || extracted.country || "",
    linkedin: profile.linkedin || extracted.linkedin || "",
    github: profile.github || extracted.github || "",
    website: profile.website || extracted.website || "",
    location: profile.location || extracted.location || "",
    _coverLetter: coverLetter || "",
    _summary: distilled.summary || "",
    _skills: skills,
    _atsResume: atsResumeText || distilled.atsResumeText || "",
    experience: Array.isArray(distilled.experience) ? distilled.experience : [],
    education: Array.isArray(distilled.education) ? distilled.education : [],
  };
}

function resolvePath(bag, path) {
  if (!path) return "";
  if (path.startsWith("_")) return bag[path] || "";
  return bag[path] || "";
}

/**
 * @param {object[]} fields  from form scanner
 * @param {object} ctx  { profile, distilled, coverLetter }
 * @returns {{ id, value, confidence, source }[]}
 */
export function mapFieldsLocal(fields, ctx) {
  const bag = buildValueBag(ctx);
  const results = [];
  // Sequential multi-row forms (Greenhouse/Lever/Workday): first "Company" → exp[0],
  // second "Company" → exp[1], etc. Shared row cursor advances on new row markers.
  const expCursor = { row: 0, seenFields: new Set() };
  const eduCursor = { row: 0, seenFields: new Set() };

  for (const f of fields || []) {
    const label = [f.label, f.name, f.id, f.placeholder, f.autocomplete]
      .filter(Boolean)
      .join(" ");
    const nl = normalizeLabel(label);
    let best = { value: null, confidence: 0, source: "missing" };

    // Experience / education indexed fields (document-style history → form rows)
    const expHit = matchIndexedSection(nl, bag.experience, EXP_PATTERNS, "experience", expCursor);
    const eduHit = matchIndexedSection(nl, bag.education, EDU_PATTERNS, "education", eduCursor);
    if (expHit && expHit.confidence >= (eduHit?.confidence || 0)) {
      best = expHit;
    } else if (eduHit) {
      best = eduHit;
    } else {
      for (const alias of ALIASES) {
        let score = 0;
        for (const k of alias.keys) {
          score = Math.max(score, scoreLabelMatch(nl, k));
        }
        // Prefer exact-ish matches on multi-word keys
        if (score > best.confidence) {
          const val = resolvePath(bag, alias.path);
          if (val) {
            best = {
              value: val,
              confidence: score,
              source: alias.path.startsWith("_") ? "derived" : "profile",
            };
          }
        }
      }
      // Large textareas labeled generically as resume/cv → ATS resume body
      if (
        (!best.value || best.confidence < 0.55) &&
        (f.type === "textarea" || f.tag === "textarea") &&
        /\b(resume|cv|curriculum)\b/.test(nl) &&
        bag._atsResume
      ) {
        best = { value: bag._atsResume, confidence: 0.7, source: "derived" };
      }
    }

    // autocomplete hints
    if ((!best.value || best.confidence < 0.5) && f.autocomplete) {
      const ac = normalizeLabel(f.autocomplete);
      const acMap = {
        email: "email",
        tel: "phone",
        "given-name": "firstName",
        "family-name": "lastName",
        name: "fullName",
        "street-address": "address",
        "address-level2": "city",
        "address-level1": "state",
        "postal-code": "zip",
        country: "country",
        "country-name": "country",
        url: "website",
      };
      for (const [k, path] of Object.entries(acMap)) {
        if (ac.includes(k) || ac === k) {
          const val = resolvePath(bag, path);
          if (val) best = { value: val, confidence: 0.9, source: "profile" };
        }
      }
    }

    if (best.confidence < 0.45) {
      best = { value: null, confidence: best.confidence, source: "missing" };
    }

    results.push({
      id: f.id,
      value: best.value,
      confidence: best.confidence,
      source: best.source,
    });
  }
  return results;
}

/**
 * Resolve row index from label text (Company 2, previous, most recent, …).
 * @returns {{ idx: number, explicit: boolean }}
 */
function resolveRowIndex(nl, rowsLen) {
  const num = nl.match(
    /(?:^|[\s\[#])(\d+)(?:\s|$|\])|(?:entry|row|item|position|job|role|employer|school)\s*(\d+)/i
  );
  if (num) {
    const n = parseInt(num[1] || num[2], 10);
    if (!Number.isNaN(n)) return { idx: Math.max(0, n >= 1 ? n - 1 : n), explicit: true };
  }
  if (/\b(previous|prior|second)\b/.test(nl)) {
    return { idx: Math.min(1, Math.max(0, rowsLen - 1)), explicit: true };
  }
  if (/\b(third)\b/.test(nl)) {
    return { idx: Math.min(2, Math.max(0, rowsLen - 1)), explicit: true };
  }
  if (/\b(fourth|4th)\b/.test(nl)) {
    return { idx: Math.min(3, Math.max(0, rowsLen - 1)), explicit: true };
  }
  if (/\b(fifth|5th)\b/.test(nl)) {
    return { idx: Math.min(4, Math.max(0, rowsLen - 1)), explicit: true };
  }
  if (/\b(most\s*recent|current|latest|primary)\b/.test(nl)) {
    return { idx: 0, explicit: true };
  }
  return { idx: 0, explicit: false };
}

/**
 * Advance sequential cursor when a field type repeats within the same logical row set.
 * e.g. employer already seen → next "employer" belongs to the next job row.
 */
function advanceCursor(cursor, fieldKey) {
  if (cursor.seenFields.has(fieldKey)) {
    cursor.row += 1;
    cursor.seenFields = new Set([fieldKey]);
  } else {
    cursor.seenFields.add(fieldKey);
  }
  return cursor.row;
}

/**
 * Map labels like "Company 2", "employer[1]", "Job Title (most recent)" onto array rows.
 * Without an explicit index, uses document order: repeated field names map to next rows.
 */
function matchIndexedSection(nl, rows, patterns, kind, cursor) {
  if (!rows?.length) return null;

  // Only treat as section field if label looks like work/education context
  const isExpContext =
    kind === "experience" &&
    /\b(company|employer|organization|job|title|position|role|work|employment|responsib|duties|experience|workplace)\b/.test(
      nl
    );
  const isEduContext =
    kind === "education" &&
    /\b(school|university|college|degree|education|major|field of study|graduation|gpa|institution)\b/.test(
      nl
    );

  if (!isExpContext && !isEduContext) {
    // Still allow bare "company name" / "job title" without the word experience
    if (
      kind === "experience" &&
      !/\b(company|employer|organization|job title|position|workplace)\b/.test(nl)
    ) {
      return null;
    }
    if (kind === "education" && !/\b(school|university|college|degree|major)\b/.test(nl)) {
      return null;
    }
  }

  const { idx: labelIdx, explicit } = resolveRowIndex(nl, rows.length);

  for (const p of patterns) {
    if (p.re.test(nl)) {
      let idx;
      if (explicit) {
        idx = labelIdx;
      } else if (cursor) {
        idx = advanceCursor(cursor, p.field);
      } else {
        idx = labelIdx;
      }
      // No silent fall-back to row 0: missing rows stay empty
      const row = rows[idx];
      if (!row) return { value: null, confidence: 0.3, source: "missing" };
      let value = row[p.field];
      if (p.field === "description" && !value && row.bullets?.length) {
        value = row.bullets.join("\n");
      }
      if (!value) return { value: null, confidence: 0.35, source: "missing" };
      return {
        value: String(value),
        confidence: explicit ? 0.85 : 0.8,
        source: "cv",
        rowIndex: idx,
      };
    }
  }

  if (kind === "experience" && /\b(company|employer|organization|workplace)\b/.test(nl)) {
    let idx;
    if (explicit) idx = labelIdx;
    else if (cursor) idx = advanceCursor(cursor, "employer");
    else idx = 0;
    const row = rows[idx];
    if (row?.employer) {
      return { value: row.employer, confidence: 0.72, source: "cv", rowIndex: idx };
    }
    return { value: null, confidence: 0.3, source: "missing" };
  }
  return null;
}

/**
 * Merge Grok field map with local map; prefer higher confidence non-null.
 */
export function mergeFieldMaps(localMaps, grokMaps) {
  const byId = new Map(localMaps.map((m) => [m.id, m]));
  for (const g of grokMaps || []) {
    const cur = byId.get(g.id);
    if (!cur) {
      byId.set(g.id, g);
      continue;
    }
    const gVal = g.value != null && g.value !== "" ? g : null;
    const cVal = cur.value != null && cur.value !== "" ? cur : null;
    if (gVal && (!cVal || (g.confidence || 0) >= (cur.confidence || 0))) {
      byId.set(g.id, { ...cur, ...g });
    }
  }
  return [...byId.values()];
}
