/**
 * Assemble an ATS-optimized plain-text resume from distilled CV + JD coverage.
 * Pure local transform — no LLM. Used for "resume text" form fields and paste export.
 *
 * Prefer Grok-written objective/summary (injected via distilled) over keyword dumps.
 */

import { expandKeywordHits, rankExperience, suggestMirroredSkills } from "./ats-heuristics.js";
import { extractCvStructure } from "./cv-structure.js";

/**
 * Build a linear, parser-friendly plain-text resume tailored to a JD.
 * Facts come only from distilled/local structure; keywords mirrored when already in CV.
 *
 * @param {{
 *   distilled?: object,
 *   cvText?: string,
 *   jobDescription?: string,
 *   jobTitle?: string,
 *   company?: string,
 *   profile?: object,
 *   objective?: string,
 *   summary?: string,
 * }} opts
 * @returns {string}
 */
export function buildAtsResumeText(opts = {}) {
  const {
    distilled,
    cvText = "",
    jobDescription = "",
    jobTitle = "",
    company = "",
    profile = {},
    objective: objectiveOverride,
    summary: summaryOverride,
  } = opts;

  const structure = distilled?.experience?.length
    ? distilled
    : { ...extractCvStructure(cvText), ...(distilled || {}) };

  const coverage = jobDescription
    ? expandKeywordHits(
        [
          cvText,
          structure.summary,
          structure.objective,
          ...(structure.skills || []),
          JSON.stringify(structure.experience || []),
        ]
          .filter(Boolean)
          .join("\n"),
        jobDescription
      )
    : { hits: structure.keywords || [], missing: [], synonymBoosts: [] };

  const mirrored = jobDescription
    ? suggestMirroredSkills(
        [cvText, ...(structure.skills || [])].join(" "),
        jobDescription,
        40
      )
    : structure.skills || [];

  // Skills: prefer distilled/Grok skills, then JD-mirrored hits that look like real skills.
  // Drop bag-of-words noise and unigram fragments already covered by multi-word skills.
  const skillSet = compactSkills([
    ...(structure.skills || []),
    ...mirrored,
    ...(coverage.hits || []),
  ]);

  // Experience: relevance order when JD present, else as distilled
  let experience = Array.isArray(structure.experience) ? [...structure.experience] : [];
  if (jobDescription && experience.length) {
    const ranked = rankExperience(experience, jobDescription);
    experience = ranked.map((r) => r.job);
  }

  const name =
    profile.fullName ||
    structure.profileFields?.fullName ||
    distilled?.profileFields?.fullName ||
    "";
  const email = profile.email || structure.profileFields?.email || "";
  const phone = profile.phone || structure.profileFields?.phone || "";
  const location =
    profile.location ||
    profile.city ||
    structure.profileFields?.location ||
    "";
  const linkedin = profile.linkedin || structure.profileFields?.linkedin || "";
  const github = profile.github || structure.profileFields?.github || "";
  const website = profile.website || structure.profileFields?.website || "";

  const lines = [];

  // Header — plain, no columns/tables
  if (name) lines.push(name);
  const contact = [email, phone, location, linkedin, github, website].filter(Boolean);
  if (contact.length) lines.push(contact.join(" | "));
  lines.push("");

  // Objective: prefer Grok-written prose; never emit keyword laundry lists
  const objective = collapseWs(
    objectiveOverride || structure.objective || distilled?.objective || ""
  );
  const objectiveText =
    objective ||
    buildFallbackObjective({
      jobTitle,
      company,
      summary: summaryOverride || structure.summary,
      hits: coverage.hits,
    });

  if (objectiveText) {
    lines.push("OBJECTIVE");
    lines.push(objectiveText);
    lines.push("");
  }

  // Summary — prefer LLM pass-1 summary over local extract; synthesize if empty
  let summary = collapseWs(
    summaryOverride || structure.summary || distilled?.summary || ""
  );
  if (!summary) {
    summary = buildFallbackSummary({
      experience,
      skills: skillSet,
      jobTitle,
      hits: coverage.hits,
    });
  }
  if (summary) {
    lines.push("SUMMARY");
    lines.push(summary);
    lines.push("");
  }

  // Skills density pack
  if (skillSet.length) {
    lines.push("SKILLS");
    lines.push(skillSet.slice(0, 45).join(", "));
    lines.push("");
  }

  // Experience
  if (experience.length) {
    lines.push("EXPERIENCE");
    for (const job of experience) {
      const head = [job.title, job.employer].filter(Boolean).join(" | ");
      const dates = [job.start, job.end].filter(Boolean).join(" – ");
      if (head) lines.push(head + (dates ? `  (${dates})` : ""));
      else if (dates) lines.push(dates);
      if (job.location) lines.push(job.location);
      const bullets =
        job.bullets?.length > 0
          ? job.bullets
          : job.description
            ? String(job.description)
                .split(/\n+/)
                .map((b) => b.trim())
                .filter(Boolean)
            : [];
      for (const b of bullets) {
        const t = collapseWs(b).replace(/^[•\-\*]\s*/, "");
        if (t) lines.push(`- ${t}`);
      }
      lines.push("");
    }
  }

  // Education
  const education = Array.isArray(structure.education) ? structure.education : [];
  if (education.length) {
    lines.push("EDUCATION");
    for (const ed of education) {
      const head = [ed.degree, ed.field, ed.school].filter(Boolean).join(", ");
      const dates = [ed.start, ed.end].filter(Boolean).join(" – ");
      if (head) lines.push(head + (dates ? `  (${dates})` : ""));
      else if (dates) lines.push(dates);
    }
    lines.push("");
  }

  // Honest gaps footnote (not for ATS paste of inventing — for user review only in notes)
  // Do NOT include missing keywords in the resume body.

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function collapseWs(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

/** Reject generic JD tokens that are not useful as resume skills. */
const SKILL_NOISE = new Set(
  `own owns owned owning senior junior staff principal lead leads leading engineer engineers
   engineering developer developers development manager managers management analyst analysts
   role roles team teams work works working company companies position positions opportunity
   experience experienced years year strong highly required preferred plus ability able
   production platform platforms services service systems system payments payment
   building build built using use used well within across looking seeking
   incident response`
    .split(/\s+/)
    .filter(Boolean)
);

function isSkillLike(term) {
  const t = String(term || "").trim();
  if (!t || t.length < 2) return false;
  const lower = t.toLowerCase();
  if (SKILL_NOISE.has(lower)) return false;
  // Single very short alpha tokens rarely map to real skills unless tech-ish
  if (/^[a-z]{1,2}$/i.test(t) && !/^(go|c|r|js|ts|ml|ai|ui|ux|qa|sre)$/i.test(t)) {
    return false;
  }
  // Bare "ci"/"cd" without slash — prefer CI/CD form from distilled skills
  if (/^(ci|cd)$/i.test(t)) return false;
  // Pure verbs / filler
  if (/^(own|run|ran|led|lead|help|make|take|get|set)$/i.test(t)) return false;
  return true;
}

/**
 * Dedupe skills and drop unigram/bigram fragments already covered by a longer phrase.
 * Keeps first-seen order (distilled skills first).
 */
function compactSkills(list, limit = 40) {
  const cleaned = [];
  const seen = new Set();
  for (const s of list || []) {
    const raw = String(s || "").trim();
    if (!raw) continue;
    const k = raw.toLowerCase();
    if (seen.has(k) || !isSkillLike(raw)) continue;
    seen.add(k);
    cleaned.push(raw);
  }
  // Prefer longer phrases: drop a term if every token appears inside another kept skill
  const kept = [];
  const keptLower = [];
  for (const s of cleaned) {
    const lower = s.toLowerCase();
    const tokens = lower.split(/[\s/,]+/).filter(Boolean);
    // Drop accidental bigrams of two skills already listed ("aws python", "kubernetes incident")
    if (
      tokens.length === 2 &&
      keptLower.some((k) => k === tokens[0] || k.split(/[\s/,]+/).includes(tokens[0])) &&
      keptLower.some((k) => k === tokens[1] || k.split(/[\s/,]+/).includes(tokens[1]))
    ) {
      continue;
    }
    const covered =
      tokens.length <= 2 &&
      kept.some((other) => {
        const o = other.toLowerCase();
        if (o === lower) return false;
        if (o.includes(lower) && o.length > lower.length) return true;
        // unigram already inside a multi-word skill
        if (tokens.length === 1 && new RegExp(`(?:^|[\\s/,])${escapeRe(lower)}(?:[\\s/,]|$)`).test(o)) {
          return true;
        }
        return false;
      });
    if (!covered) {
      kept.push(s);
      keptLower.push(lower);
    }
  }
  return kept.slice(0, limit);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Local fallback when the LLM did not supply an objective.
 * Uses role/company + a short natural phrase — not "Core strengths: a, b, c".
 */
function buildFallbackObjective({ jobTitle, company, summary, hits }) {
  const roleBit = jobTitle
    ? `Seeking the ${jobTitle} role`
    : "Seeking a role matching this posting";
  const companyBit = company ? ` at ${company}` : "";
  // Pull first clause of summary if it already sounds targeted
  const sum = collapseWs(summary);
  if (sum && sum.length > 40) {
    const first = sum.split(/(?<=[.!?])\s+/)[0];
    if (first && first.length >= 40 && first.length <= 280) {
      // If summary already names the role, use it alone as objective
      if (
        (jobTitle && first.toLowerCase().includes(String(jobTitle).toLowerCase().slice(0, 12))) ||
        /applying|seeking|candidate|background|experience/i.test(first)
      ) {
        return first;
      }
    }
  }
  // One strong hit as a capability phrase, not a comma list
  const top = (hits || []).find((h) => String(h).split(/\s+/).length <= 4);
  if (top) {
    return `${roleBit}${companyBit}, bringing demonstrated strength in ${top}.`;
  }
  if (jobTitle || company) return `${roleBit}${companyBit}.`;
  return "";
}

/**
 * Local fallback summary when LLM hooks are unavailable.
 * Built only from structured experience/skills already in the CV — never invents.
 */
function buildFallbackSummary({ experience, skills, jobTitle, hits }) {
  const parts = [];
  const topJobs = (experience || []).slice(0, 2);
  if (topJobs.length) {
    const titles = topJobs
      .map((j) => [j.title, j.employer].filter(Boolean).join(" at "))
      .filter(Boolean);
    if (titles.length) {
      parts.push(
        jobTitle
          ? `Background spanning ${titles.join("; ")}, aligned to ${jobTitle} responsibilities.`
          : `Background spanning ${titles.join("; ")}.`
      );
    }
    const bullet = topJobs
      .flatMap((j) => j.bullets || [])
      .map((b) => collapseWs(b).replace(/^[•\-\*]\s*/, ""))
      .find((b) => b && b.length >= 40 && b.length <= 220);
    if (bullet) parts.push(bullet);
  }
  const skillBits = (skills || []).slice(0, 8);
  const hitBits = (hits || []).filter((h) =>
    skillBits.some((s) => s.toLowerCase().includes(String(h).toLowerCase()))
  );
  const pack = [...new Set([...(hitBits.length ? hitBits : skillBits)].map(String))].slice(0, 6);
  if (pack.length) {
    parts.push(`Core capabilities include ${pack.join(", ")}.`);
  }
  return collapseWs(parts.join(" "));
}

/**
 * Pull contact-ish fields from raw CV text for profile prefill.
 * Never invents — only regex extractions present in the text.
 */
export function extractContactFromCv(cvText) {
  const text = String(cvText || "");
  const out = {};

  const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  if (email) out.email = email[0];

  const phone = text.match(
    /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}\b/
  );
  if (phone && phone[0].replace(/\D/g, "").length >= 10) out.phone = phone[0].trim();

  const linkedin = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/[^\s)]+/i);
  if (linkedin) out.linkedin = linkedin[0].replace(/[.,;]+$/, "");

  const github = text.match(/https?:\/\/(?:www\.)?github\.com\/[^\s)]+/i);
  if (github) out.github = github[0].replace(/[.,;]+$/, "");

  const website = text.match(
    /https?:\/\/(?:www\.)?(?!(?:linkedin|github)\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/?[^\s)]*/i
  );
  if (website) out.website = website[0].replace(/[.,;]+$/, "");

  // First non-empty line often is the name if short and not a section header
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const firstLine = lines.find((l) => l.length > 2 && l.length < 60);
  if (
    firstLine &&
    !/@/.test(firstLine) &&
    !/^(experience|education|skills|summary|objective|curriculum|resume|cv)\b/i.test(
      firstLine
    ) &&
    !/\d{3}/.test(firstLine) &&
    /^[A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){0,4}$/.test(firstLine)
  ) {
    out.fullName = firstLine;
  }

  // Address parsing: street address (with optional Apt/Suite/Unit/Ste/#), City, State Zip
  // Example: "1890 W Hillcrest Dr, Apt 580, Newbury Park, CA 91320"
  const fullAddressMatch = text.match(
    /\b(\d{1,5}\s+[^,\n]+?)(?:,\s*((?:Apt|Suite|Unit|Ste|Bldg|Building|Dept|#)\s*[^,\n]+))?,\s*([A-Za-z.\s]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/i
  );

  if (fullAddressMatch) {
    const streetPart = fullAddressMatch[1].trim();
    const unitPart = fullAddressMatch[2] ? fullAddressMatch[2].trim() : "";
    out.address = unitPart ? `${streetPart}, ${unitPart}` : streetPart;
    out.city = fullAddressMatch[3].trim();
    out.state = fullAddressMatch[4].trim().toUpperCase();
    out.zip = fullAddressMatch[5].trim();
    out.location = fullAddressMatch[0].trim();
  } else {
    // Street Address, City, State (no Zip)
    const streetCityStateMatch = text.match(
      /\b(\d{1,5}\s+[^,\n]+?)(?:,\s*((?:Apt|Suite|Unit|Ste|Bldg|Building|Dept|#)\s*[^,\n]+))?,\s*([A-Za-z.\s]+),\s*([A-Z]{2})\b/i
    );
    if (streetCityStateMatch && !/linkedin|github/i.test(streetCityStateMatch[0])) {
      const streetPart = streetCityStateMatch[1].trim();
      const unitPart = streetCityStateMatch[2] ? streetCityStateMatch[2].trim() : "";
      out.address = unitPart ? `${streetPart}, ${unitPart}` : streetPart;
      out.city = streetCityStateMatch[3].trim();
      out.state = streetCityStateMatch[4].trim().toUpperCase();
      out.location = streetCityStateMatch[0].trim();

      // Check if Zip follows immediately
      const rest = text.slice(streetCityStateMatch.index + streetCityStateMatch[0].length);
      const zipM = rest.match(/^\s+(\d{5}(?:-\d{4})?)\b/);
      if (zipM) {
        out.zip = zipM[1];
        out.location += " " + zipM[1];
      }
    } else {
      // City, State Zip (no street)
      const cityStateZipMatch = text.match(
        /\b([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)*),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/
      );
      if (cityStateZipMatch) {
        out.city = cityStateZipMatch[1].trim();
        out.state = cityStateZipMatch[2].trim().toUpperCase();
        out.zip = cityStateZipMatch[3].trim();
        out.location = cityStateZipMatch[0].trim();
      } else {
        // City, State (no street or zip)
        const loc = text.match(
          /\b([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)*),\s*([A-Z]{2})\b/
        );
        if (loc && !/linkedin|github/i.test(loc[0])) {
          out.location = loc[0].trim();
          out.city = loc[1].trim();
          out.state = loc[2].trim();
        }
      }
    }
  }

  return out;
}

/**
 * Build a professional, ATS-aligned local fallback cover letter.
 * Pure local transform — no LLM required.
 * Guarantees that a complete cover letter is generated even when all LLMs fail.
 *
 * @param {{
 *   distilled?: object,
 *   cvText?: string,
 *   jobDescription?: string,
 *   jobTitle?: string,
 *   company?: string,
 *   profile?: object,
 * }} opts
 * @returns {string}
 */
export function buildLocalCoverLetter(opts = {}) {
  const {
    distilled,
    cvText = "",
    jobDescription = "",
    jobTitle = "",
    company = "",
    profile = {},
  } = opts;

  const structure = distilled?.experience?.length
    ? distilled
    : { ...extractCvStructure(cvText), ...(distilled || {}) };

  const extractedProfile = extractContactFromCv(cvText);
  const name =
    profile.fullName ||
    structure.profileFields?.fullName ||
    extractedProfile.fullName ||
    "Applicant";

  const email = profile.email || structure.profileFields?.email || extractedProfile.email || "";
  const phone = profile.phone || structure.profileFields?.phone || extractedProfile.phone || "";
  const location =
    profile.location ||
    profile.city ||
    structure.profileFields?.location ||
    extractedProfile.location ||
    "";
  const linkedin = profile.linkedin || structure.profileFields?.linkedin || extractedProfile.linkedin || "";

  const targetRole = (jobTitle || "").trim() || "the advertised role";
  const targetCompany = (company || "").trim() || "your organization";

  const coverage = jobDescription
    ? expandKeywordHits(
        [
          cvText,
          structure.summary,
          structure.objective,
          ...(structure.skills || []),
          JSON.stringify(structure.experience || []),
        ]
          .filter(Boolean)
          .join("\n"),
        jobDescription
      )
    : { hits: structure.keywords || [], missing: [] };

  const skillSet = compactSkills([
    ...(structure.skills || []),
    ...(coverage.hits || []),
  ]);

  const experience = Array.isArray(structure.experience) ? structure.experience : [];

  const lines = [];

  // Header
  lines.push(name);
  const contact = [location, email, phone, linkedin].filter(Boolean);
  if (contact.length) lines.push(contact.join(" | "));
  lines.push("");

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  lines.push(today);
  lines.push("");
  lines.push("Hiring Manager");
  lines.push(targetCompany);
  lines.push("");
  lines.push(`RE: Application for ${targetRole}`);
  lines.push("");
  lines.push("Dear Hiring Manager,");
  lines.push("");

  // Paragraph 1: Opening & Aptitude Intro
  const topSkillsStr = skillSet.slice(0, 4).join(", ");
  const skillClause = topSkillsStr ? ` with core expertise in ${topSkillsStr}` : "";
  lines.push(
    `I am writing to express my strong interest in the ${targetRole} position at ${targetCompany}. With my solid background in this field${skillClause}, I am confident in my ability to deliver immediate value and contribute effectively to your team's goals.`
  );
  lines.push("");

  // Paragraph 2: Experience & Achievements
  if (experience.length > 0) {
    const primaryJob = experience[0];
    const jobHead = [primaryJob.title, primaryJob.employer].filter(Boolean).join(" at ");
    const bullets = (primaryJob.bullets || [])
      .map((b) => collapseWs(b).replace(/^[•\-\*]\s*/, ""))
      .filter((b) => b && b.length > 20);

    let expDetail = primaryJob.title
      ? `In my role as ${jobHead}, I focused on driving results and maintaining high technical standards.`
      : "Throughout my professional experience, I have consistently focused on delivering robust results.";
    if (bullets.length > 0) {
      expDetail += ` Key achievements include: ${bullets.slice(0, 2).join("; ")}.`;
    }
    lines.push(expDetail);
    lines.push("");
  }

  // Paragraph 3: Alignment & Skills
  const keywordsStr = (coverage.hits || []).slice(0, 5).join(", ");
  let alignMsg = `My technical and professional capabilities align closely with the requirements for the ${targetRole} position.`;
  if (keywordsStr) {
    alignMsg += ` My hands-on experience spans key areas including ${keywordsStr}.`;
  }
  const summaryText = collapseWs(structure.summary || structure.objective || "");
  if (summaryText) {
    alignMsg += ` ${summaryText}`;
  }
  lines.push(alignMsg);
  lines.push("");

  // Paragraph 4: Closing
  lines.push(
    `Thank you for your time and consideration. I would welcome the opportunity to discuss how my background and experience align with the needs of ${targetCompany}. I look forward to speaking with you.`
  );
  lines.push("");
  lines.push("Sincerely,");
  lines.push("");
  lines.push(name);

  return lines.join("\n").trim();
}
