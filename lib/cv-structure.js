/**
 * Local heuristic CV structure extraction.
 * Used when Grok is unavailable so form mapping still has experience rows.
 * Never invents employers/dates — only groups lines that already appear in the CV.
 */

const SECTION_RE =
  /^(experience|work experience|employment|professional experience|work history|education|skills|technical skills|summary|profile|objective|projects|certifications|awards|publications|interests|references)\s*:?\s*$/i;

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

const DATE_TOKEN = `(?:${MONTH}\\.?\\s+\\d{4}|\\d{1,2}/\\d{4}|\\d{4})`;
const END_TOKEN = `(?:${DATE_TOKEN}|[Pp]resent|[Cc]urrent|[Nn]ow)`;
// Full range: "Jan 2020 – Present", "2018-2019", "2018 to 2019"
const FULL_RANGE_RE = new RegExp(
  `\\b(${DATE_TOKEN})\\s*(?:[–—\\-]|\\s+to\\s+)\\s*(${END_TOKEN})\\b`,
  "i"
);

const ROLE_HINT =
  /\b(engineer|developer|manager|analyst|director|lead|specialist|consultant|intern|officer|architect|scientist|designer|administrator|coordinator|technician|programmer|sre|devops)\b/i;

/**
 * @param {string} cvText
 * @returns {{ summary: string, skills: string[], experience: object[], education: object[], keywords: string[], gaps: string[] }}
 */
export function extractCvStructure(cvText) {
  const text = String(cvText || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n").map((l) => l.replace(/\s+$/g, ""));

  const sections = splitSections(lines);
  const expLines = sections.experience || sections.work || [];
  const experience = parseExperience(expLines.length ? expLines : lines);
  const education = parseEducation(sections.education || []);
  const skills = parseSkills(sections.skills || sections["technical skills"] || []);
  const summaryLines = sections.summary || sections.profile || sections.objective || [];
  const summary =
    summaryLines.join(" ").replace(/\s+/g, " ").trim() ||
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 40 && !SECTION_RE.test(l))
      .slice(0, 3)
      .join(" ")
      .slice(0, 600);

  return {
    summary,
    skills,
    experience,
    education,
    keywords: skills.slice(0, 30),
    gaps: [],
  };
}

function splitSections(lines) {
  const map = {};
  let current = "_preamble";
  map[current] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t && SECTION_RE.test(t) && t.length < 60) {
      current = t.replace(/:$/, "").toLowerCase();
      if (!map[current]) map[current] = [];
      continue;
    }
    if (!map[current]) map[current] = [];
    map[current].push(line);
  }
  if (map["work experience"] && !map.experience) map.experience = map["work experience"];
  if (map["professional experience"] && !map.experience)
    map.experience = map["professional experience"];
  if (map["work history"] && !map.experience) map.experience = map["work history"];
  if (map["technical skills"] && !map.skills) map.skills = map["technical skills"];
  return map;
}

function emptyJob() {
  return {
    employer: "",
    title: "",
    start: "",
    end: "",
    location: "",
    description: "",
    bullets: [],
  };
}

function isBullet(line) {
  return /^[•\-\*·▪▸►]/.test(line) || /^\d+[.)]\s+/.test(line);
}

function stripBullet(line) {
  return line.replace(/^[•\-\*·▪▸►]\s*/, "").replace(/^\d+[.)]\s+/, "");
}

function isDateOnlyLine(line) {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  const m = t.match(FULL_RANGE_RE);
  if (!m) return false;
  const rest = t.replace(FULL_RANGE_RE, "").replace(/[|@–—,\-]/g, " ").trim();
  return rest.length < 3;
}

function parseJobHeader(line) {
  const t = line.trim();
  if (!t || isBullet(t) || isDateOnlyLine(t)) return null;
  if (t.length > 120) return null;

  const range = t.match(FULL_RANGE_RE);
  const withoutDates = range
    ? t.replace(FULL_RANGE_RE, "").replace(/\s+/g, " ").trim()
    : t;
  // Require a separator for header: Title | Company  or  Title @ Company  or  Title – Company
  const parts = withoutDates
    .split(/\s*[|@]\s*|\s+[–—]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    // "Title, Company" only if role hint present
    const comma = withoutDates.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
    if (comma.length === 2 && ROLE_HINT.test(comma[0])) {
      return {
        title: comma[0],
        employer: comma[1],
        start: range ? range[1] : "",
        end: range ? range[2] : "",
      };
    }
    return null;
  }

  let title = parts[0];
  let employer = parts.slice(1).join(" ");
  // If left looks like company and right like role, swap
  if (!ROLE_HINT.test(title) && ROLE_HINT.test(employer)) {
    const tmp = title;
    title = employer;
    employer = tmp;
  }

  return {
    title,
    employer,
    start: range ? range[1] : "",
    end: range ? range[2] : "",
  };
}

function parseExperience(lines) {
  if (!lines?.length) return [];
  const jobs = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    if (cur.employer || cur.title || cur.bullets.length) {
      if (!cur.description && cur.bullets.length) {
        cur.description = cur.bullets.join("\n");
      }
      jobs.push(cur);
    }
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (SECTION_RE.test(line)) continue;

    const header = parseJobHeader(line);
    if (header) {
      flush();
      cur = emptyJob();
      cur.title = header.title;
      cur.employer = header.employer;
      cur.start = header.start;
      cur.end = header.end;
      continue;
    }

    if (isDateOnlyLine(line)) {
      const range = line.match(FULL_RANGE_RE);
      if (range) {
        if (!cur) cur = emptyJob();
        cur.start = cur.start || range[1];
        cur.end = cur.end || range[2];
      }
      continue;
    }

    if (isBullet(line)) {
      if (!cur) cur = emptyJob();
      cur.bullets.push(stripBullet(line));
      continue;
    }

    // Prose under current job only — never start a job from a random line
    if (cur) {
      if (line.length < 80 && !cur.location && /,\s*[A-Z]{2}\b/.test(line)) {
        cur.location = line;
      } else {
        cur.bullets.push(line);
      }
    }
  }
  flush();
  return jobs.slice(0, 12);
}

function parseEducation(lines) {
  const out = [];
  let buf = [];
  const pushBuf = () => {
    if (!buf.length) return;
    const blob = buf.join(" ");
    const degreeM = blob.match(
      /\b(Ph\.?D\.?|M\.?S\.?|M\.?A\.?|B\.?S\.?|B\.?A\.?|MBA|Associate|Bachelor(?:'s)?|Master(?:'s)?|Doctorate)[^,\n]*/i
    );
    const years = blob.match(/\b((?:19|20)\d{2})\b/g) || [];
    out.push({
      school: buf[0] || "",
      degree: degreeM ? degreeM[0].trim() : "",
      field: "",
      start: years.length > 1 ? years[0] : "",
      end: years.slice(-1)[0] || "",
    });
    buf = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      pushBuf();
      continue;
    }
    if (buf.length && /^[A-Z0-9]/.test(line) && line.length < 90 && buf.length >= 2) {
      pushBuf();
    }
    buf.push(line);
  }
  pushBuf();
  return out.slice(0, 8);
}

function parseSkills(lines) {
  const blob = (lines || []).join(", ");
  if (!blob.trim()) return [];
  return blob
    .split(/[,;|•\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length < 60)
    .slice(0, 60);
}
