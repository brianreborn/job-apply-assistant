/**
 * Lightweight ATS-oriented helpers that run locally (no LLM).
 * Complements Grok prompts with deterministic keyword overlap.
 */

import { normalizeLabel } from "./util.js";

const STOP = new Set(
  `a an the and or of to for in on with by from as at is are was were be been being
   this that these those it its we our you your they their will can may must should
   job role team work company position opportunity about us who what when where how
   have has had do does did not no yes etc including such other more most than then
   looking seeking required requirements require requires preferred plus ability able
   strong highly experience experienced years year using use used well within across
   per via need needs needed please join join us apply applicant candidates candidate
   description responsibilities responsibility qualifications qualification duties duty
   benefits benefit equal opportunity employer eoe all rights reserved`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Extract significant keywords from a job description.
 */
export function extractKeywords(jdText, limit = 40) {
  const counts = new Map();
  const tokens = String(jdText || "")
    .toLowerCase()
    .replace(/[^a-z0-9+.#\s/-]/g, " ")
    .split(/[\s/,;|]+/)
    .map((t) => t.replace(/^[\s.#/-]+|[\s.#/-]+$/g, ""))
    .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));

  // Prefer multi-word tech-ish tokens already single; also keep c++, c#, .net style
  for (const t of tokens) {
    counts.set(t, (counts.get(t) || 0) + 1);
  }

  // Bigrams — skip pairs that are pure stop-ish noise after filtering
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a.length <= 2 || b.length <= 2) continue;
    if (STOP.has(a) || STOP.has(b)) continue;
    const bi = `${a} ${b}`;
    counts.set(bi, (counts.get(bi) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

/**
 * Score CV text against JD keywords.
 */
export function keywordCoverage(cvText, jdText) {
  const keywords = extractKeywords(jdText);
  const cv = normalizeLabel(cvText);
  const hits = [];
  const missing = [];
  for (const { term } of keywords) {
    if (cv.includes(normalizeLabel(term))) hits.push(term);
    else missing.push(term);
  }
  return {
    keywords: keywords.map((k) => k.term),
    hits,
    missing,
    coverage: keywords.length ? hits.length / keywords.length : 0,
  };
}

/**
 * Suggest which CV experience entries best match the JD (by keyword overlap).
 */
export function rankExperience(experience, jdText) {
  const kw = extractKeywords(jdText, 30).map((k) => k.term);
  return (experience || [])
    .map((job, index) => {
      const blob = normalizeLabel(
        [job.title, job.employer, job.description, ...(job.bullets || [])].join(" ")
      );
      let score = 0;
      const matched = [];
      for (const t of kw) {
        if (blob.includes(normalizeLabel(t))) {
          score++;
          matched.push(t);
        }
      }
      return { index, score, matched, job };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Build a short local ATS note when Grok is unavailable.
 */
export function localAtsNotes(coverage) {
  const pct = Math.round((coverage.coverage || 0) * 100);
  return (
    `Local ATS scan: ${pct}% of top JD keywords appear in the CV. ` +
    `Hits: ${coverage.hits.slice(0, 12).join(", ") || "none"}. ` +
    `Gaps (do not invent): ${coverage.missing.slice(0, 12).join(", ") || "none"}. ` +
    `When Grok runs: mirror JD wording for hits, front-load role+matches, pack skills density, ` +
    `rephrase bullets into JD vocabulary, rewrite cover intro to trip keyword rankers — facts stay true.`
  );
}

/**
 * Common tech synonym expansions for local keyword density (truthful only if base term in CV).
 * Maps JD-ish terms → alternate forms that may appear in a CV.
 */
const SYNONYM_GROUPS = [
  ["javascript", "js", "ecmascript", "node.js", "nodejs"],
  ["typescript", "ts"],
  ["python", "py"],
  ["kubernetes", "k8s"],
  ["continuous integration", "ci", "ci/cd", "cicd"],
  ["continuous delivery", "cd", "ci/cd", "cicd"],
  ["amazon web services", "aws"],
  ["google cloud", "gcp", "google cloud platform"],
  ["microsoft azure", "azure"],
  ["machine learning", "ml", "deep learning"],
  ["artificial intelligence", "ai"],
  ["rest", "restful", "rest api", "restful api"],
  ["postgresql", "postgres", "psql"],
  ["mongodb", "mongo"],
  ["elasticsearch", "elastic search", "elk"],
  ["team leadership", "people management", "managed a team", "led a team"],
  ["incident response", "on-call", "on call", "pagerduty"],
  ["infrastructure as code", "iac", "terraform", "cloudformation"],
  ["user experience", "ux"],
  ["user interface", "ui"],
  ["customer relationship management", "crm"],
  ["search engine optimization", "seo"],
  ["full stack", "full-stack", "fullstack"],
  ["front end", "frontend", "front-end"],
  ["back end", "backend", "back-end"],
  ["devops", "dev ops", "site reliability", "sre"],
];

/**
 * Expand coverage: if CV has a synonym of a JD keyword, count it as a hit under the JD form.
 * Helps local fallbacks game bag-of-words without inventing skills.
 */
/** Whole-token match so short forms like "ui"/"ai"/"js" do not hit inside "required"/"email". */
function tokenPresent(haystackNorm, needleNorm) {
  if (!needleNorm) return false;
  if (needleNorm.length <= 3) {
    return new RegExp(`(?:^|\\s)${escapeRe(needleNorm)}(?:\\s|$)`).test(haystackNorm);
  }
  return haystackNorm.includes(needleNorm);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function expandKeywordHits(cvText, jdText) {
  const base = keywordCoverage(cvText, jdText);
  const cv = normalizeLabel(cvText);
  const jd = normalizeLabel(jdText);
  const extraHits = [];
  for (const group of SYNONYM_GROUPS) {
    const forms = group.map((g) => normalizeLabel(g));
    const jdHas = forms.some((f) => tokenPresent(jd, f));
    const cvHas = forms.some((f) => tokenPresent(cv, f));
    if (jdHas && cvHas) {
      // Prefer the JD-facing form (first group member that appears in JD)
      const jdForm =
        group.find((g) => tokenPresent(jd, normalizeLabel(g))) || group[0];
      if (!base.hits.includes(jdForm) && !extraHits.includes(jdForm)) {
        extraHits.push(jdForm);
      }
    }
  }
  const hits = [...new Set([...base.hits, ...extraHits])];
  const missing = base.missing.filter(
    (m) => !hits.some((h) => normalizeLabel(h) === normalizeLabel(m))
  );
  return {
    ...base,
    hits,
    missing,
    coverage:
      base.keywords.length > 0
        ? hits.filter((h) =>
            base.keywords.some((k) => normalizeLabel(k) === normalizeLabel(h))
          ).length / base.keywords.length
        : hits.length
          ? Math.min(1, hits.length / Math.max(base.keywords.length, 1))
          : base.coverage,
    synonymBoosts: extraHits,
  };
}

/**
 * Suggest JD-aligned skill phrases that already appear (or as substrings) in the CV.
 * Helps local fallbacks surface keyword density without inventing tools.
 */
export function suggestMirroredSkills(cvText, jdText, limit = 25) {
  const coverage = keywordCoverage(cvText, jdText);
  return coverage.hits.slice(0, limit);
}
