/**
 * Grok prompt builders. Prefer combined multi-task calls to reduce quota use.
 */

export const SYSTEM_CORE = `You are JobApply Assistant, helping a job seeker beat automated HR screening (ATS) that discards most applications before any human reads them. Those systems are not playing fair — keyword gates, primitive ranking LLMs, and resume parsers that reward format tricks over substance. You optimize materials to survive that filter while remaining factually honest about the candidate's real history.

HARD RULES (facts):
1. Never invent employers, job titles, dates, degrees, certifications, tools, or skills that are not supported by the CV text. Employment history must be true.
2. Prefer verbatim phrases from the CV when they remain readable for a typical HR reader.
3. Soften dense jargon only when it would block comprehension; do not over-rewrite the candidate's diction and style.
4. If information is missing, omit it or use null/empty — never fabricate experience.
5. Cover letters must emphasize specific CV points that match the job description; rewrite the introduction around relevance, not a generic template.
6. Output valid JSON only (no markdown fences unless asked).

ATS / ranking-LLM "gaming" (use every legal lever — the filter is the adversary):
A. MIRROR EXACT JD VOCABULARY for anything the CV already supports. If the CV says "JS" and the JD says "JavaScript", write "JavaScript". Expand abbreviations both ways: "CRM (Customer Relationship Management)" when the concept is in the CV. Match casing and compound terms from the JD ("CI/CD", "REST APIs", "full-stack").
B. FRONT-LOAD MATCHES. The first 1–2 sentences of summary and cover letter must contain the role title (or closest truthful equivalent), company, and the single strongest keyword cluster from the JD that the CV supports. Primitive rankers overweight early tokens.
C. KEYWORD DENSITY WITHOUT LYING. Build a dense skills array packed with JD-aligned terms drawn only from CV evidence (and close truthful synonyms). Repeat high-value JD terms naturally across summary, skills, and 2–3 experience bullets — not as a spam dump, but enough that bag-of-words and embedding scorers light up.
D. SEMANTIC NEAR-MATCHES. When the CV supports a capability under different wording, rephrase bullets so they contain the JD's preferred phrase (e.g. CV "ran on-call rotations" → "owned production incident response and on-call reliability" if the JD asks for incident response). Same accomplishment, JD-native language.
E. PARSER-FRIENDLY STRUCTURE. Plain linear text: no tables, columns, icons, headers-as-images, or decorative unicode. Standard section names (Experience, Skills, Education). Dates as Month YYYY or YYYY. Bullets start with strong verbs.
F. TITLE ALIGNMENT. If the JD title is a reasonable description of work the candidate has done, use that title phrasing in the summary/cover ("applying as a … with background in …") even when past employers used different internal titles — but keep historical job titles in experience rows accurate to the CV.
G. SOFT-SKILL TRIGGERS ATS LLMs LOOK FOR. When the CV supports them, surface collaboration, ownership, delivery under ambiguity, stakeholder communication, mentoring — using JD language. Do not invent soft skills.
H. EXPERIENCE ORDERING FOR RELEVANCE. In distilled.experience, order roles by relevance to the JD first (most relevant first), not strictly chronology, while keeping each role's dates accurate. Mark current/most recent dates correctly.
I. COVER LETTER STRUCTURE (rewrite fully):
   - Para 1: role + company + one concrete CV match using JD keywords (hook the ranker).
   - Para 2–3: map 2–3 CV achievements to specific JD requirements with mirrored vocabulary.
   - Final: availability/interest, no generic fluff.
   Keep 3–5 short paragraphs. Prefer CV diction; inject JD keywords where truthful.
J. VISIBLE TEXT ONLY. No white-on-white, zero-font, hidden divs, or invisible keyword stuffing — those get people blacklisted. Game the scorer with professional, visible content.
K. GAPS: list honestly in "gaps" / missingKeywords. Never paper over missing hard requirements with fiction. Do reframe adjacent strengths when the CV has a near-miss.

When Grok would otherwise produce generic corporate mush, prefer shorter, denser, keyword-rich sentences that still sound like a competent human wrote them from this CV.`;

/**
 * Pass 1 — hooks only: objective, summary, cover letter, emphasis.
 * Separate from body generation so aptitude-forward prose is not diluted by
 * long structured extraction in a single call.
 */
export function buildHookPrompt({ cvText, jobDescription, jobTitle, company }) {
  return {
    system: SYSTEM_CORE,
    user: `PASS 1 OF 2 — Write only the high-impact introduction pieces for this application. Do NOT dump the full resume body yet. Quality of aptitude demonstration is the top priority.

JOB TITLE: ${jobTitle || "(unknown)"}
COMPANY: ${company || "(unknown)"}

JOB DESCRIPTION:
---
${jobDescription}
---

CV (source of truth — never invent employers, dates, degrees, tools, or skills):
---
${cvText}
---

Write three tightly targeted pieces:

1) OBJECTIVE (1–2 sentences, ATS paste section "OBJECTIVE")
   - Name the target role and company when known.
   - State the single strongest truthful aptitude bridge from CV → this JD (what you do well that they need).
   - Mirror 2–4 high-value JD terms the CV supports. No keyword laundry lists.
   - Sound like a competent human, not "Core strengths aligned to this role: a, b, c".

2) PROFESSIONAL SUMMARY (3–5 sentences)
   - Sentence 1 MUST show aptitude: role-fit + one concrete CV accomplishment or capability that maps to a JD requirement (with numbers/scope if the CV has them).
   - Remaining sentences deepen 1–2 more relevance points; prefer CV diction; inject JD vocabulary only where truthful.
   - Front-load ranker hits; no generic corporate mush ("passionate team player seeking growth").

3) COVER LETTER (full rewrite, 3–5 short paragraphs)
   - Para 1 (critical): role + company + concrete CV evidence of aptitude for THIS posting. Make a human reader (and a primitive ranker) immediately see why this candidate is interesting.
   - Paras 2–3: map specific CV achievements to specific JD requirements with mirrored vocabulary.
   - Final: clear interest/availability; no fluff.
   - Prefer verbatim CV phrases when they stay readable.

Also list the 3–6 relevance points you emphasized (for user review).

Return JSON only:
{
  "objective": "1-2 sentence targeted objective",
  "summary": "3-5 sentence professional summary showing aptitude for this JD",
  "coverLetter": "full cover letter body",
  "emphasisPoints": ["specific CV→JD relevance points used above"],
  "keywordHooks": ["JD terms intentionally front-loaded because CV supports them"]
}`,
  };
}

/**
 * Pass 2 — body: experience/skills/education + ATS notes, anchored to pass-1 hooks.
 */
export function buildBodyPrompt({
  cvText,
  jobDescription,
  jobTitle,
  company,
  objective,
  summary,
  emphasisPoints,
  keywordHooks,
}) {
  return {
    system: SYSTEM_CORE,
    user: `PASS 2 OF 2 — Build the structured resume body for ATS forms. The objective and summary below are LOCKED from pass 1 — do not rewrite them; align skills and experience language to support them.

JOB TITLE: ${jobTitle || "(unknown)"}
COMPANY: ${company || "(unknown)"}

JOB DESCRIPTION:
---
${jobDescription}
---

CV (source of truth for facts):
---
${cvText}
---

LOCKED HOOKS (use as-is; experience bullets should reinforce these claims with evidence from the CV):
OBJECTIVE:
${objective || "(none)"}

SUMMARY:
${summary || "(none)"}

EMPHASIS POINTS:
${JSON.stringify(emphasisPoints || [], null, 2)}

KEYWORD HOOKS:
${JSON.stringify(keywordHooks || [], null, 2)}

Return JSON only:
{
  "distilled": {
    "objective": ${JSON.stringify(objective || "")},
    "summary": ${JSON.stringify(summary || "")},
    "skills": ["dense JD-aligned skill strings supported by the CV — pack parser-friendly terms; prefer JD wording when truthful"],
    "experience": [
      {
        "employer": "",
        "title": "historical title as on CV (accurate)",
        "start": "",
        "end": "",
        "location": "",
        "description": "prose if present on CV",
        "bullets": ["ATS-friendly bullets; rephrase with JD keywords only when truthful; reinforce locked summary claims with concrete evidence"]
      }
    ],
    "education": [
      { "school": "", "degree": "", "field": "", "start": "", "end": "" }
    ],
    "keywords": ["JD keywords present or strongly implied in CV"],
    "gaps": ["JD requirements not evidenced in CV"]
  },
  "ats": {
    "keywordHits": ["keywords from JD found in CV"],
    "missingKeywords": ["important JD keywords absent from CV — do not fake them"],
    "rewrittenBullets": ["optional lightly rephrased bullets if still truthful"],
    "atsNotes": "short notes on mirroring, density, and how body supports the locked objective/summary"
  },
  "profileFields": {
    "fullName": "if clearly in CV else null",
    "email": "if clearly in CV else null",
    "phone": "if clearly in CV else null",
    "location": "city/region if clearly in CV else null",
    "linkedin": "if clearly in CV else null",
    "github": "if clearly in CV else null",
    "website": "if clearly in CV else null"
  }
}

Order experience by relevance to the JD (most relevant first). Keep each role's historical title and dates accurate to the CV.`,
  };
}

/**
 * Single-call fallback when two-pass is unavailable (e.g. after partial failure).
 * Prefer buildHookPrompt + buildBodyPrompt in the main pipeline.
 */
export function buildAnalyzePrompt({ cvText, jobDescription, jobTitle, company }) {
  return {
    system: SYSTEM_CORE,
    user: `Analyze this CV against the job and produce application materials optimized to pass ATS keyword filters and primitive ranking models while staying truthful to the CV.

PRIORITY: The objective, professional summary, and cover-letter introduction must demonstrate clear aptitude for THIS role using concrete CV evidence — not generic keyword dumps.

JOB TITLE: ${jobTitle || "(unknown)"}
COMPANY: ${company || "(unknown)"}

JOB DESCRIPTION:
---
${jobDescription}
---

CV (source of truth for facts — do not invent employers, dates, degrees, or tools beyond this):
---
${cvText}
---

Return a single JSON object with this exact shape:
{
  "objective": "1-2 sentence targeted objective: role + company + strongest truthful aptitude bridge; no keyword laundry lists",
  "distilled": {
    "objective": "same as top-level objective",
    "summary": "3-5 sentence professional summary; sentence 1 shows aptitude with a concrete CV match to the JD; front-load role + strongest matches",
    "skills": ["dense list of skill strings relevant to JD, using JD wording when CV supports them — pack parser-friendly terms"],
    "experience": [
      {
        "employer": "",
        "title": "historical title as on CV (accurate)",
        "start": "",
        "end": "",
        "location": "",
        "description": "prose description if present",
        "bullets": ["ATS-friendly bullets; rephrase with JD keywords only when truthful to this role"]
      }
    ],
    "education": [
      { "school": "", "degree": "", "field": "", "start": "", "end": "" }
    ],
    "keywords": ["JD keywords present or strongly implied in CV"],
    "gaps": ["JD requirements not evidenced in CV"]
  },
  "ats": {
    "keywordHits": ["keywords from JD found in CV"],
    "missingKeywords": ["important JD keywords absent from CV — do not fake them"],
    "rewrittenBullets": ["optional CV bullets lightly rephrased for ATS keyword clarity; only if still truthful"],
    "atsNotes": "short notes on keyword mirroring, front-loading, density, and skills packing applied"
  },
  "coverLetter": "full cover letter body, 3-5 short paragraphs; intro MUST show aptitude with specific CV evidence and JD vocabulary",
  "emphasisPoints": ["bullet list of the relevance points emphasized"],
  "profileFields": {
    "fullName": "if clearly in CV else null",
    "email": "if clearly in CV else null",
    "phone": "if clearly in CV else null",
    "location": "city/region if clearly in CV else null",
    "linkedin": "if clearly in CV else null",
    "github": "if clearly in CV else null",
    "website": "if clearly in CV else null"
  }
}`,
  };
}

/**
 * Map scanned form fields to values from structured profile / distilled CV.
 */
export function buildFieldMapPrompt({ fields, distilled, profile, coverLetter }) {
  return {
    system: SYSTEM_CORE,
    user: `Map application form fields to values derived only from the candidate data.
Leave value as null if the data is not present — never invent.

CANDIDATE PROFILE (user-supplied + distilled):
${JSON.stringify({ profile, distilled, coverLetter: coverLetter ? coverLetter.slice(0, 4000) : null }, null, 2)}

FORM FIELDS (from the live page):
${JSON.stringify(fields, null, 2)}

Return JSON:
{
  "fields": [
    {
      "id": "field id from input",
      "value": "string or null",
      "confidence": 0.0,
      "source": "profile|cv|coverLetter|derived|missing"
    }
  ],
  "notes": "brief mapping notes"
}

Special handling:
- Work history multi-row forms: expand distilled.experience into employer/title/start/end/description fields by index (most relevant first = 0 or 1 depending on labels; "previous/prior" = next). Transform document-style history into discrete field inputs — every employer/title/date/description that can be derived MUST be filled.
- Education multi-row: same for distilled.education (school, degree, field, dates).
- Cover letter / additional info / message / "why do you want" fields: use coverLetter when appropriate.
- Skills / qualifications free-text: join distilled.skills with JD-mirrored terms.
- Summary / about you / resume text / CV text paste areas: prefer distilled.summary or a linear ATS resume from experience+skills (not empty if data exists).
- Checkbox legal attestations: leave null (user must click).
- Salary / compensation: leave null unless explicitly in profile.
- Demographics / EEO optional: leave null unless in profile.
- File upload resume fields: leave null (user attaches file manually).`,
  };
}

