/**
 * Extract job title, company, and description from common ATS / job pages.
 * Heuristic only — user can always paste JD manually in the sidebar.
 */
(function (global) {
  "use strict";

  // Prefer specific job-title hooks BEFORE bare h1 — many ATS pages put
  // browser-support / cookie banners in an earlier h1 (e.g. SmartRecruiters IE11).
  const SELECTORS = {
    title: [
      // SmartRecruiters
      "[data-test='job-title']",
      "[data-test='jobAdHeader-title']",
      ".job-title",
      "h1.job-title",
      ".jobad-header h1",
      ".spl-job-ad-header h1",
      // Greenhouse / Lever / LinkedIn / Indeed / Workday / generic ATS
      "[data-testid='job-title']",
      ".posting-headline h2",
      ".posting-headline h1",
      "#job-title",
      ".jobsearch-JobInfoHeader-title",
      ".topcard__title",
      "[class*='JobTitle']",
      "[class*='job-title']",
      "[class*='jobTitle']",
      "h1[class*='title']",
      "[data-automation-id='jobPostingHeader']",
      ".job-details-jobs-unified-top-card__job-title",
      "h1.app-title",
      "main h1",
      "[role='main'] h1",
      "article h1",
      // Last resort — scored/filtered, never first-match only
      "h1",
      "h2",
    ],
    company: [
      "[data-testid='company-name']",
      "[data-test='company-name']",
      ".company-name",
      ".employer",
      ".topcard__org-name-link",
      ".jobsearch-InlineCompanyRating a",
      "[class*='CompanyName']",
      "[class*='company-name']",
      ".posting-categories .company",
      "a[data-qa='job-company']",
      "[data-automation-id='company']",
      ".job-details-jobs-unified-top-card__company-name a",
      ".company",
    ],
    description: [
      "#content",
      "#job-description",
      ".job-description",
      "[data-testid='job-description']",
      "[data-test='job-description']",
      ".description__text",
      ".show-more-less-html__markup",
      "#jobDescriptionText",
      ".jobs-description__content",
      ".jobs-box__html-content",
      "[class*='JobDescription']",
      "[class*='job-description']",
      ".posting-page .section-wrapper",
      "[data-automation-id='jobPostingDescription']",
      ".jobs-description-content__text",
      "#job-details",
      "article",
      "main",
      "[role='main']",
    ],
  };

  /** Banners, cookie walls, browser warnings — never a job title. */
  const TITLE_NOISE_RE =
    /\b(internet explorer|ie\s*11|no longer supported|browser.*(not supported|unsupported)|unsupported browser|please (upgrade|update) your browser|cookie|cookies? (policy|consent|settings|notice)|we use cookies|accept (all )?cookies|privacy (policy|notice)|enable javascript|javascript (is )?(required|disabled)|access denied|just a moment|attention required|cloudflare|captcha|are you a robot|sign in to continue|log in to continue|sorry[,!.]?\s)/i;

  const TITLE_NOISE_EXACT_RE =
    /^(home|careers|jobs|job openings|search|menu|navigation|skip to (main )?content|loading|error|404|not found)$/i;

  function normalizeTitleCandidate(raw) {
    return String(raw || "")
      .replace(/\s+/g, " ")
      .trim()
      .split("\n")[0]
      .trim()
      .slice(0, 300);
  }

  function isNoiseTitle(t) {
    if (!t || t.length < 2) return true;
    if (t.length > 180) return true; // real titles are short
    if (TITLE_NOISE_EXACT_RE.test(t)) return true;
    if (TITLE_NOISE_RE.test(t)) return true;
    // Full sentences that read like status messages
    if (/^(sorry|oops|error|warning|notice|attention)\b/i.test(t)) return true;
    if (/\bis no longer supported\b/i.test(t)) return true;
    return false;
  }

  /**
   * Score a title candidate. Higher = more likely a real job title.
   * Specific selectors get a base boost via `specificityBonus`.
   */
  function scoreTitle(text, el, specificityBonus) {
    if (isNoiseTitle(text)) return -1000;
    let score = specificityBonus || 0;
    const lower = text.toLowerCase();

    // Prefer job-like phrasing
    if (
      /\b(engineer|developer|manager|analyst|director|designer|scientist|specialist|coordinator|consultant|architect|administrator|officer|lead|intern|associate|principal|staff|senior|junior|head of|vp|vice president|product|marketing|sales|recruiter|accountant|nurse|teacher|technician)\b/i.test(
        text
      )
    ) {
      score += 25;
    }
    // Reasonable length for a title
    if (text.length >= 8 && text.length <= 90) score += 10;
    else if (text.length > 120) score -= 15;

    // Prefer elements that look job-related
    if (el) {
      const cls = `${el.className || ""} ${el.id || ""} ${el.getAttribute("data-test") || ""} ${el.getAttribute("data-testid") || ""}`.toLowerCase();
      if (/job[-_]?title|jobad|posting|position|role/.test(cls)) score += 40;
      if (/banner|alert|warning|cookie|browser|unsupported|ie11|notice|toast/.test(cls)) score -= 50;
      if (el.closest("nav, footer, [role='navigation'], [role='banner'], .cookie, #cookie")) score -= 40;
      // Main content is better than early page chrome
      if (el.closest("main, article, [role='main'], .job, [class*='job-ad'], [class*='JobAd']")) score += 15;
    }

    // Penalize titles that are just the ATS brand
    if (/^(smartrecruiters|greenhouse|lever|workday|ashby|indeed|linkedin)\b/i.test(lower)) score -= 30;

    return score;
  }

  /**
   * Collect title candidates from selectors; return best non-noise match.
   * Never blindly take the first h1 on the page.
   */
  function bestTitleText(selectors) {
    let best = { text: "", score: -Infinity };

    selectors.forEach((sel, selIndex) => {
      // Earlier selectors are more specific
      const specificityBonus = Math.max(0, 50 - selIndex * 2);
      try {
        const nodes = document.querySelectorAll(sel);
        for (const el of nodes) {
          if (!el) continue;
          const t = normalizeTitleCandidate(el.innerText || el.textContent || "");
          if (!t) continue;
          const score = scoreTitle(t, el, specificityBonus);
          if (score > best.score) best = { text: t, score };
        }
      } catch {
        /* invalid selector in some contexts */
      }
    });

    return best.score > 0 ? best.text : best.score > -500 ? best.text : "";
  }

  function firstText(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const t = normalizeTitleCandidate(el.innerText || el.textContent || "");
        if (t.length > 1 && !isNoiseTitle(t)) return t;
      } catch {
        /* invalid selector in some contexts */
      }
    }
    return "";
  }

  function cleanMetaTitle(raw) {
    let t = normalizeTitleCandidate(raw);
    if (!t) return "";
    // og:title often "Role at Company | SmartRecruiters" or "Role - Company"
    t = t
      .replace(/\s*[|\-–—]\s*(SmartRecruiters|Greenhouse|Lever|LinkedIn|Indeed|Workday|Ashby|Glassdoor).*$/i, "")
      .replace(/\s+at\s+[^-|–—]+$/i, (m) => {
        // keep "at Company" only if the left side still looks like a title
        return m;
      })
      .trim();
    // If still "Sorry, Internet Explorer…" reject
    if (isNoiseTitle(t)) return "";
    // Strip trailing " | Careers" noise
    t = t.replace(/\s*[|\-–—]\s*(Careers|Jobs|Job Openings|Home)\s*$/i, "").trim();
    return t;
  }

  function longestText(selectors, minLen = 200) {
    let best = "";
    for (const sel of selectors) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (const el of nodes) {
          if (!el || el.closest("nav, header, footer, [role='navigation']")) continue;
          const t = (el.innerText || el.textContent || "").trim();
          // Skip pure browser-support banners as "description"
          if (t.length < 400 && TITLE_NOISE_RE.test(t) && !/\b(responsibilit|qualif|requirement|about the role)\b/i.test(t)) {
            continue;
          }
          if (t.length > best.length) best = t;
        }
      } catch {
        /* */
      }
    }
    if (best.length < minLen) {
      // Fallback: body text without nav/header/footer and known chrome
      const clone = document.body ? document.body.cloneNode(true) : null;
      if (clone) {
        clone
          .querySelectorAll(
            "nav, header, footer, script, style, noscript, [role='navigation'], [class*='cookie'], [id*='cookie'], [class*='browser-support'], [class*='ie-support']"
          )
          .forEach((n) => n.remove());
        const t = (clone.innerText || "").trim();
        if (t.length > best.length) best = t;
      }
    }
    // Cap to keep prompts reasonable
    return best.slice(0, 50000);
  }

  function metaContent(nameOrProp) {
    const m =
      document.querySelector(`meta[property="${nameOrProp}"]`) ||
      document.querySelector(`meta[name="${nameOrProp}"]`);
    return m?.content?.trim() || "";
  }

  function extractJobDescription() {
    const pageUrl = location.href;
    let jobTitle =
      bestTitleText(SELECTORS.title) ||
      cleanMetaTitle(metaContent("og:title")) ||
      cleanMetaTitle(metaContent("twitter:title")) ||
      cleanMetaTitle(document.title.split(/[|\-–—]/)[0]);

    // Final guard: never ship IE/cookie banner as the title
    if (isNoiseTitle(jobTitle)) jobTitle = "";

    let company =
      firstText(SELECTORS.company) ||
      metaContent("og:site_name") ||
      "";
    // Don't treat ATS brand as company when site_name is the platform
    if (/^(smartrecruiters|greenhouse|lever|workday|ashby|indeed|linkedin)$/i.test(company.trim())) {
      company = "";
    }

    // Greenhouse: often company in URL path boards.greenhouse.io/company
    if (!company) {
      const gh = location.hostname.match(/greenhouse\.io/i);
      if (gh) {
        const parts = location.pathname.split("/").filter(Boolean);
        if (parts[0] && parts[0] !== "jobs") company = parts[0];
      }
    }
    // Lever
    if (!company && /lever\.co/i.test(location.hostname)) {
      const parts = location.pathname.split("/").filter(Boolean);
      if (parts[0]) company = parts[0];
    }
    // Ashby
    if (!company && /ashbyhq\.com/i.test(location.hostname)) {
      const parts = location.pathname.split("/").filter(Boolean);
      if (parts[0]) company = parts[0];
    }
    // Workday myworkdayjobs
    if (!company && /myworkdayjobs\.com/i.test(location.hostname)) {
      const parts = location.hostname.split(".");
      if (parts[0] && parts[0] !== "www") company = parts[0];
    }
    // SmartRecruiters: jobs.smartrecruiters.com/CompanyName/...
    if (!company && /smartrecruiters\.com/i.test(location.hostname)) {
      const parts = location.pathname.split("/").filter(Boolean);
      // paths like /CompanyName/job-id-slug or /CompanyName/123/...
      if (parts[0] && !/^(jobs|app|oneclick|v1|v2)$/i.test(parts[0])) {
        company = decodeURIComponent(parts[0]).replace(/[-_]/g, " ");
      }
    }

    const text = longestText(SELECTORS.description, 120);

    return {
      jobTitle: jobTitle || "",
      company: company || "",
      text: text || "",
      pageUrl,
      extractedAt: new Date().toISOString(),
      host: location.hostname,
    };
  }

  global.JobApplyJd = { extractJobDescription };
})(typeof globalThis !== "undefined" ? globalThis : window);
