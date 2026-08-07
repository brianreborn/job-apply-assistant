/**
 * Application pipeline orchestration.
 */

import { uuid, nowIso } from "../lib/util.js";
import { MSG } from "../lib/messages.js";
import {
  buildHookPrompt,
  buildBodyPrompt,
  buildAnalyzePrompt,
  buildFieldMapPrompt,
} from "../lib/prompts.js";
import { mapFieldsLocal, mergeFieldMaps } from "../lib/field-mapper.js";
import { expandKeywordHits, localAtsNotes, rankExperience } from "../lib/ats-heuristics.js";
import { extractCvStructure } from "../lib/cv-structure.js";
import { buildAtsResumeText, extractContactFromCv, buildLocalCoverLetter } from "../lib/ats-resume.js";
import {
  getCv,
  saveCv,
  deleteCv,
  getProfile,
  setProfile,
  saveApplication,
  getApplication,
  listApplications,
  isUnlocked,
  getSettings,
  patchSettings,
} from "./secure-store.js";
import { grokChat, withRetry } from "./grok-client.js";
import { audit } from "./audit-log.js";
import { scanForReview, approvePiiValues } from "./pii-gate.js";
import { findPiiCandidates } from "../lib/redaction.js";

/**
 * Single global application session for the whole browser profile.
 * Shared across every window/tab/sidebar instance — one active job at a time.
 * Persisted so background restarts still restore the same draft.
 */
let currentAppId = null;
let currentAppIdLoaded = false;

async function resolveCurrentAppId() {
  if (currentAppIdLoaded && currentAppId) return currentAppId;
  currentAppIdLoaded = true;
  try {
    const settings = await getSettings();
    if (settings.currentAppId) {
      const existing = await getApplication(settings.currentAppId);
      if (existing) {
        currentAppId = existing.id;
        return currentAppId;
      }
    }
  } catch {
    /* */
  }
  const list = await listApplications();
  if (list[0]) {
    currentAppId = list[0].id;
    await persistCurrentAppId(currentAppId);
  }
  return currentAppId;
}

async function persistCurrentAppId(id) {
  currentAppId = id || null;
  currentAppIdLoaded = true;
  try {
    await patchSettings({ currentAppId: id || null }, null);
  } catch {
    /* settings may be unavailable mid-lock */
  }
  // Notify all UI surfaces (sidebars, popups) so they stay in sync
  try {
    browser.runtime
      .sendMessage({
        type: MSG.EVENT,
        event: "application.changed",
        appId: id || null,
      })
      .catch(() => {});
  } catch {
    /* no listeners */
  }
}

export async function setCvText(text, meta = {}) {
  if (!text?.trim()) throw new Error("CV text is empty");
  const row = await saveCv({
    id: "current",
    source: meta.source || "paste",
    name: meta.name || "pasted-cv",
    text,
    fetchedAt: nowIso(),
    ...meta,
  });
  // Explicit CV submission for application use may include personal info (user-vetted by action).
  try {
    const found = findPiiCandidates(text);
    if (found.length) {
      await approvePiiValues(
        found.map((c) => ({ value: c.value, type: `cv:${c.type}` }))
      );
    }
  } catch {
    /* allowlist best-effort */
  }
  // Prefill empty profile fields from CV contact lines (does not overwrite user values)
  try {
    await mergeProfileFromCv(text);
  } catch {
    /* best-effort */
  }
  await audit({
    purpose: "pipeline.setCv",
    channel: "local",
    note: `${meta.source || "paste"} · ${text.length} chars`,
  });
  return row;
}

/**
 * Fill blank profile slots from CV contact extraction. Never overwrites non-empty fields.
 */
async function mergeProfileFromCv(cvText) {
  const extracted = extractContactFromCv(cvText);
  if (!Object.keys(extracted).length) return null;
  const existing = (await getProfile()) || {};
  const merged = { ...existing };
  let changed = false;
  for (const [k, v] of Object.entries(extracted)) {
    if (!v) continue;
    if (!merged[k] || !String(merged[k]).trim()) {
      merged[k] = v;
      changed = true;
    }
  }
  if (changed) await setProfile(merged);
  return changed ? merged : null;
}

export async function getCurrentCv() {
  return getCv("current");
}

export async function clearCurrentCv() {
  await deleteCv("current");
  await audit({ purpose: "pipeline.clearCv", channel: "local" });
  return null;
}

/**
 * Persist cover letter edits from the UI without re-running Grok.
 */
export async function saveCoverLetter(coverLetter) {
  const app = await ensureApp();
  return saveApplication({
    ...app,
    coverLetter: coverLetter ?? "",
    updatedAt: nowIso(),
  });
}

/**
 * Persist ATS resume text edits from the UI.
 */
export async function saveAtsResumeText(atsResumeText) {
  const app = await ensureApp();
  return saveApplication({
    ...app,
    atsResumeText: atsResumeText ?? "",
    updatedAt: nowIso(),
  });
}

async function ensureApp(partial = {}) {
  await resolveCurrentAppId();
  if (currentAppId) {
    const existing = await getApplication(currentAppId);
    if (existing) {
      const merged = { ...existing, ...partial, updatedAt: nowIso() };
      return saveApplication(merged);
    }
  }
  const app = await saveApplication({
    id: uuid(),
    status: "draft",
    jobTitle: partial.jobTitle || "",
    company: partial.company || "",
    jobDescription: partial.jobDescription || "",
    pageUrl: partial.pageUrl || "",
    distilled: null,
    ats: null,
    coverLetter: "",
    emphasisPoints: [],
    fieldMap: [],
    formFields: [],
    ...partial,
  });
  await persistCurrentAppId(app.id);
  return app;
}

export async function setJdText({ text, jobTitle, company, pageUrl }) {
  const app = await ensureApp({
    jobDescription: text || "",
    jobTitle: jobTitle || "",
    company: company || "",
    pageUrl: pageUrl || "",
  });
  // JD is user-submitted application context — auto-allow PII-like tokens found
  // there (recruiter emails, company phones, office addresses) so the gate does
  // not block Analyze over non-candidate data the user already chose to include.
  try {
    const found = findPiiCandidates(
      [text, jobTitle, company].filter(Boolean).join("\n")
    );
    if (found.length) {
      await approvePiiValues(
        found.map((c) => ({ value: c.value, type: `jd:${c.type}` }))
      );
    }
  } catch {
    /* best-effort */
  }
  await audit({
    purpose: "pipeline.setJd",
    channel: "local",
    note: `JD ${text?.length || 0} chars`,
  });
  return app;
}

/**
 * Capture JD from active tab via content script.
 */
export async function captureJdFromTab(tabId) {
  const res = await sendToTab(tabId, { type: MSG.CONTENT_EXTRACT_JD });
  if (!res?.ok) throw new Error(res?.error || "Failed to extract job description");
  const data = res.data;
  return setJdText({
    text: data.text,
    jobTitle: data.jobTitle,
    company: data.company,
    pageUrl: data.pageUrl,
  });
}

/**
 * Full analyze: PII scan → Grok (two-pass or single-pass per combinePrompts) → persist drafts.
 */
export async function runAnalyze({ forceRedact = false } = {}) {
  if (!isUnlocked()) throw new Error("Vault locked");
  const cv = await getCurrentCv();
  if (!cv?.text) throw new Error("Load a CV first");

  let app = await ensureApp();
  if (!app.jobDescription?.trim()) {
    throw new Error("Capture or paste a job description first");
  }

  // Pre-scan PII for UI awareness
  const unvetted = await scanForReview([cv.text, app.jobDescription]);
  if (unvetted.length && !forceRedact) {
    // Still attempt gate inside grokChat; surface preview
  }

  // Local ATS scan with synonym expansion (JS↔JavaScript, k8s↔Kubernetes, etc.)
  const localCoverage = expandKeywordHits(cv.text, app.jobDescription);
  const localStructure = extractCvStructure(cv.text);
  // Merge local keyword hits into structure for form-fill fallback
  localStructure.keywords = [
    ...new Set([
      ...(localStructure.keywords || []),
      ...localCoverage.hits,
      ...(localCoverage.synonymBoosts || []),
    ]),
  ];
  localStructure.gaps = localCoverage.missing.slice(0, 20);
  // Relevance-order experience for ATS even before Grok
  if (localStructure.experience?.length) {
    localStructure.experience = rankExperience(
      localStructure.experience,
      app.jobDescription
    ).map((r) => r.job);
  }

  const profile = await getProfile();
  const settings = await getSettings();
  // combinePrompts: single LLM call first (saves quota). Off = quality-first two-pass.
  const preferSinglePass = settings.combinePrompts !== false;
  const jobCtx = {
    cvText: cv.text,
    jobDescription: app.jobDescription,
    jobTitle: app.jobTitle,
    company: app.company,
  };

  /**
   * Analyze modes:
   *   two-pass     — hooks (objective/summary/cover) then body (skills/exp/edu)
   *   single-pass  — one combined call (combinePrompts setting, or two-pass fallback)
   *   hooks-only   — pass 1 succeeded, pass 2 failed → local body
   * Falls back to local CV structure if all LLM backends fail.
   */
  let hooks = null;
  let bodyJson = null;
  let backend = null;
  let analyzeMode = preferSinglePass ? "single-pass" : "two-pass";

  async function runSinglePass() {
    const combined = buildAnalyzePrompt(jobCtx);
    const result = await withRetry(() =>
      grokChat({
        system: combined.system,
        user: combined.user,
        purpose: "grok.analyze",
        temperature: 0.4,
      })
    );
    const json = result.json || {};
    return {
      hooks: {
        objective: json.objective || json.distilled?.objective || "",
        summary: json.distilled?.summary || "",
        coverLetter: json.coverLetter || "",
        emphasisPoints: json.emphasisPoints || [],
        keywordHooks: json.ats?.keywordHits || [],
      },
      bodyJson: json,
      backend: result.backend,
    };
  }

  async function runTwoPass() {
    const hookPrompt = buildHookPrompt(jobCtx);
    const hookResult = await withRetry(() =>
      grokChat({
        system: hookPrompt.system,
        user: hookPrompt.user,
        purpose: "grok.analyze.hooks",
        temperature: 0.45,
      })
    );
    const h = hookResult.json || {};
    let mode = "two-pass";
    let b = null;
    let be = hookResult.backend;
    await audit({
      purpose: "pipeline.analyze.hooks.done",
      channel: "local",
      note: `backend=${be} objective=${(h.objective || "").length} summary=${(h.summary || "").length} cover=${(h.coverLetter || "").length}`,
    });
    try {
      const bodyPrompt = buildBodyPrompt({
        ...jobCtx,
        objective: h.objective || "",
        summary: h.summary || "",
        emphasisPoints: h.emphasisPoints || [],
        keywordHooks: h.keywordHooks || [],
      });
      const bodyResult = await withRetry(() =>
        grokChat({
          system: bodyPrompt.system,
          user: bodyPrompt.user,
          purpose: "grok.analyze.body",
          temperature: 0.3,
        })
      );
      b = bodyResult.json || {};
      be = bodyResult.backend || be;
      await audit({
        purpose: "pipeline.analyze.body.done",
        channel: "local",
        note: `backend=${be}`,
      });
    } catch (bodyErr) {
      if (bodyErr.code === "PII_REVIEW_REQUIRED") throw bodyErr;
      mode = "hooks-only";
      await audit({
        purpose: "pipeline.analyze.body.fallback",
        channel: "local",
        error: bodyErr.message,
        note: bodyErr.code || undefined,
      });
    }
    return { hooks: h, bodyJson: b, backend: be, analyzeMode: mode };
  }

  try {
    if (preferSinglePass) {
      const r = await runSinglePass();
      hooks = r.hooks;
      bodyJson = r.bodyJson;
      backend = r.backend;
      analyzeMode = "single-pass";
      await audit({
        purpose: "pipeline.analyze.single.done",
        channel: "local",
        note: `backend=${backend} combinePrompts=true`,
      });
    } else {
      const r = await runTwoPass();
      hooks = r.hooks;
      bodyJson = r.bodyJson;
      backend = r.backend;
      analyzeMode = r.analyzeMode;
    }
  } catch (err) {
    if (err.code === "PII_REVIEW_REQUIRED") throw err;

    // Alternate path once before pure local fallback (unless all backends exhausted).
    let err2 = err;
    if (err.code !== "NEED_MORE_ACCOUNTS") {
      try {
        if (preferSinglePass) {
          // Quota mode failed → try quality two-pass once
          const r = await runTwoPass();
          hooks = r.hooks;
          bodyJson = r.bodyJson;
          backend = r.backend;
          analyzeMode = r.analyzeMode;
          err2 = null;
        } else {
          // Quality mode failed → try single combined call once
          const r = await runSinglePass();
          hooks = r.hooks;
          bodyJson = r.bodyJson;
          backend = r.backend;
          analyzeMode = "single-pass";
          err2 = null;
        }
      } catch (e) {
        if (e.code === "PII_REVIEW_REQUIRED") throw e;
        err2 = e;
      }
    }

    if (err2) {
      await audit({
        purpose: "pipeline.analyze.fallback",
        channel: "local",
        error: err2.message || err.message,
        note: err2.code || err.code || undefined,
      });
      const atsResumeText = buildAtsResumeText({
        distilled: localStructure,
        cvText: cv.text,
        jobDescription: app.jobDescription,
        jobTitle: app.jobTitle,
        company: app.company,
        profile,
      });
      const coverLetter =
        app.coverLetter ||
        buildLocalCoverLetter({
          distilled: localStructure,
          cvText: cv.text,
          jobDescription: app.jobDescription,
          jobTitle: app.jobTitle,
          company: app.company,
          profile,
        });
      app = await saveApplication({
        ...app,
        status: "analyze_partial",
        distilled: localStructure,
        ats: {
          keywordHits: localCoverage.hits,
          missingKeywords: localCoverage.missing,
          rewrittenBullets: [],
          atsNotes:
            localAtsNotes(localCoverage) +
            ` Local CV structure: ${localStructure.experience.length} job(s), ${localStructure.education.length} education. LLM error: ${err2.message || err.message}. Tip: add an OpenAI API key in Options — it is used automatically when Grok (xAI or X session) fails, including 404 session errors. CV/JD/profile were preserved.`,
        },
        // Keep prior cover letter / ATS text if user already edited; generate local fallback if empty
        coverLetter,
        atsResumeText: atsResumeText || app.atsResumeText || "",
        emphasisPoints: app.emphasisPoints?.length ? app.emphasisPoints : ["Local CV structure used (LLM unavailable)"],
        analyzeError: err2.message || err.message,
        analyzeCode: err2.code || err.code || null,
        analyzeMode: "local",
        // Never clear distilled/CV-linked state beyond this partial structure
      });
      // Return partial app instead of throwing — UI shows analyzeError; CV/JD stay intact.
      return app;
    }
  }

  const json = bodyJson || {};
  const objective =
    (hooks?.objective && String(hooks.objective).trim()) ||
    (json.objective && String(json.objective).trim()) ||
    (json.distilled?.objective && String(json.distilled.objective).trim()) ||
    "";
  const summary =
    (hooks?.summary && String(hooks.summary).trim()) ||
    (json.distilled?.summary && String(json.distilled.summary).trim()) ||
    localStructure.summary ||
    "";

  // Prefer Grok structure; fill holes from local parse so form mapping still works
  let distilled = {
    ...localStructure,
    ...(json.distilled || {}),
    objective,
    summary,
    experience:
      json.distilled?.experience?.length > 0
        ? json.distilled.experience
        : localStructure.experience,
    education:
      json.distilled?.education?.length > 0
        ? json.distilled.education
        : localStructure.education,
    skills:
      json.distilled?.skills?.length > 0 ? json.distilled.skills : localStructure.skills,
  };
  // If Grok kept chronology and we have JD hits, re-rank only when scores clearly differ
  if (distilled.experience?.length && app.jobDescription) {
    const ranked = rankExperience(distilled.experience, app.jobDescription);
    if (ranked[0]?.score > (ranked[ranked.length - 1]?.score || 0)) {
      distilled = { ...distilled, experience: ranked.map((r) => r.job) };
    }
  }

  // Always assemble ATS resume from structured parts so objective/summary prose
  // (pass 1) is not lost to a low-quality freeform dump.
  const atsResumeText = buildAtsResumeText({
    distilled,
    cvText: cv.text,
    jobDescription: app.jobDescription,
    jobTitle: app.jobTitle,
    company: app.company,
    profile: { ...profile, ...(json.profileFields || {}) },
    objective,
    summary,
  });

  const coverLetter =
    (hooks?.coverLetter && String(hooks.coverLetter).trim()) ||
    (json.coverLetter && String(json.coverLetter).trim()) ||
    "";
  const emphasisPoints =
    (hooks?.emphasisPoints?.length && hooks.emphasisPoints) ||
    json.emphasisPoints ||
    [];

  // Prefer Grok ATS notes; always surface how objective/summary were produced
  const atsBlock = json.ats || {
    keywordHits: localCoverage.hits,
    missingKeywords: localCoverage.missing,
    rewrittenBullets: [],
    atsNotes: localAtsNotes(localCoverage),
  };
  if (analyzeMode === "hooks-only") {
    atsBlock.atsNotes =
      (atsBlock.atsNotes ? atsBlock.atsNotes + " " : "") +
      "Body pass failed or was skipped — objective/summary/cover from pass 1 kept; experience/skills from local CV parse.";
  } else if (analyzeMode === "two-pass") {
    atsBlock.atsNotes =
      (atsBlock.atsNotes ? atsBlock.atsNotes + " " : "") +
      "Two-pass LLM: aptitude-first objective/summary/cover, then JD-aligned body.";
  } else if (analyzeMode === "single-pass") {
    atsBlock.atsNotes =
      (atsBlock.atsNotes ? atsBlock.atsNotes + " " : "") +
      "Single-pass LLM (combine prompts / quota mode).";
  }

  app = await saveApplication({
    ...app,
    status: "analyzed",
    distilled,
    ats: atsBlock,
    coverLetter,
    atsResumeText,
    emphasisPoints,
    profileFields: json.profileFields || null,
    grokBackend: backend,
    analyzeMode,
    analyzeError: null,
  });

  // Soft-merge Grok-extracted contact into empty profile slots
  if (json.profileFields) {
    try {
      const pf = {};
      for (const [k, v] of Object.entries(json.profileFields)) {
        if (v != null && String(v).trim()) pf[k] = String(v).trim();
      }
      if (Object.keys(pf).length) {
        const existing = (await getProfile()) || {};
        const merged = { ...existing };
        let changed = false;
        for (const [k, v] of Object.entries(pf)) {
          if (!merged[k]) {
            merged[k] = v;
            changed = true;
          }
        }
        if (changed) await setProfile(merged);
      }
    } catch {
      /* */
    }
  }

  await audit({
    purpose: "pipeline.analyze.done",
    channel: "local",
    note: `backend=${backend} mode=${analyzeMode}`,
  });
  return app;
}

/**
 * Scan forms on tab + map fields (local + optional Grok).
 */
export async function mapFieldsForTab(tabId, { useGrok = true } = {}) {
  if (!isUnlocked()) throw new Error("Vault locked");
  const scan = await sendToTab(tabId, { type: MSG.CONTENT_SCAN_FORMS });
  if (!scan?.ok) throw new Error(scan?.error || "Form scan failed");
  const formFields = scan.data?.fields || [];

  let app = await ensureApp({ formFields });
  const profile = await getProfile();
  const cv = await getCurrentCv();

  // Local structure so multi-row experience/education fill works without Grok analyze
  if (!app.distilled?.experience?.length && cv?.text) {
    const localStructure = extractCvStructure(cv.text);
    if (app.jobDescription && localStructure.experience?.length) {
      localStructure.experience = rankExperience(
        localStructure.experience,
        app.jobDescription
      ).map((r) => r.job);
    }
    app = await saveApplication({
      ...app,
      distilled: { ...(app.distilled || {}), ...localStructure },
    });
  }

  // Ensure ATS resume text exists for paste fields even if analyze was partial
  let atsResumeText = app.atsResumeText || "";
  if (!atsResumeText && (app.distilled || cv?.text)) {
    atsResumeText = buildAtsResumeText({
      distilled: app.distilled,
      cvText: cv?.text || "",
      jobDescription: app.jobDescription || "",
      jobTitle: app.jobTitle || "",
      company: app.company || "",
      profile: { ...profile, ...(app.profileFields || {}) },
    });
    app = await saveApplication({ ...app, atsResumeText });
  }

  // Merge Grok-extracted contact fields under distilled for local mapper helpers
  const distilled = {
    ...(app.distilled || {}),
    profileFields: app.profileFields || app.distilled?.profileFields || null,
    atsResumeText,
  };
  const ctx = {
    profile: { ...profile, ...(app.profileFields || {}) },
    distilled,
    coverLetter: app.coverLetter || "",
    atsResumeText,
  };

  let localMap = mapFieldsLocal(formFields, ctx);
  let grokMap = [];

  if (useGrok && app.distilled) {
    try {
      const prompt = buildFieldMapPrompt({
        fields: formFields.map((f) => ({
          id: f.id,
          label: f.label,
          name: f.name,
          type: f.type,
          placeholder: f.placeholder,
        })),
        distilled: { ...app.distilled, atsResumeText },
        profile: ctx.profile,
        coverLetter: app.coverLetter,
      });
      const result = await grokChat({
        system: prompt.system,
        user: prompt.user,
        purpose: "grok.fieldMap",
      });
      grokMap = result.json?.fields || [];
    } catch (err) {
      await audit({
        purpose: "pipeline.mapFields.grokFail",
        channel: "local",
        error: err.message,
      });
      if (err.code === "PII_REVIEW_REQUIRED" || err.code === "NEED_MORE_ACCOUNTS") throw err;
    }
  }

  const fieldMap = mergeFieldMaps(localMap, grokMap);
  // Attach labels for UI
  const byId = new Map(formFields.map((f) => [f.id, f]));
  const enriched = fieldMap.map((m) => ({
    ...m,
    label: byId.get(m.id)?.label || byId.get(m.id)?.name || m.id,
    type: byId.get(m.id)?.type,
  }));

  app = await saveApplication({
    ...app,
    formFields,
    fieldMap: enriched,
    status: "mapped",
  });
  return app;
}

/**
 * Fill form on tab — never submits.
 */
export async function fillFormOnTab(tabId) {
  await resolveCurrentAppId();
  let app = currentAppId ? await getApplication(currentAppId) : null;
  if (!app?.fieldMap?.length) {
    app = await mapFieldsForTab(tabId, { useGrok: false });
  } else if (app.coverLetter || app.atsResumeText) {
    // Keep cover-letter / ATS resume field values in sync with sidebar edits
    app = await saveApplication({
      ...app,
      fieldMap: (app.fieldMap || []).map((m) => {
        const label = `${m.label || ""} ${m.id || ""}`.toLowerCase();
        if (/cover|letter|additional info|message|why do you want/.test(label) && app.coverLetter) {
          if (!m.value || m.source === "derived" || m.value === app.coverLetter) {
            return { ...m, value: app.coverLetter, source: "derived" };
          }
        }
        if (/\b(resume|cv|curriculum)\b/.test(label) && app.atsResumeText) {
          if (!m.value || m.source === "derived" || m.value === app.atsResumeText) {
            return { ...m, value: app.atsResumeText, source: "derived" };
          }
        }
        return m;
      }),
    });
  }
  const fills = (app.fieldMap || [])
    .filter((m) => m.value != null && m.value !== "")
    .map((m) => ({ id: m.id, value: m.value }));

  const res = await sendToTab(tabId, {
    type: MSG.CONTENT_FILL,
    fills,
  });
  if (!res?.ok) throw new Error(res?.error || "Fill failed");

  app = await saveApplication({
    ...app,
    status: "filled",
    fillResult: res.data,
    filledAt: nowIso(),
  });
  await audit({
    purpose: "pipeline.fill",
    channel: "local",
    note: `filled ${res.data?.filled || 0} fields; submit never automated`,
  });
  return app;
}

export async function getCurrentApplication() {
  await resolveCurrentAppId();
  return currentAppId ? getApplication(currentAppId) : null;
}

/**
 * Start a fresh global application draft (explicit user action).
 * Previous drafts remain in history via listApplications.
 */
export async function newApplication(partial = {}) {
  await persistCurrentAppId(null);
  return ensureApp({
    jobTitle: partial.jobTitle || "",
    company: partial.company || "",
    jobDescription: partial.jobDescription || "",
    pageUrl: partial.pageUrl || "",
    distilled: null,
    ats: null,
    coverLetter: "",
    atsResumeText: "",
    emphasisPoints: [],
    fieldMap: [],
    formFields: [],
    profileFields: null,
    status: "draft",
  });
}

export { listApplications };

const CONTENT_SCRIPTS = [
  "content/submit-guard.js",
  "content/jd-extractor.js",
  "content/form-scanner.js",
  "content/form-filler.js",
  "content/content.js",
];

/**
 * Send a message to a tab's content script, injecting scripts if the page
 * was loaded before the temporary add-on (or the content script is missing).
 */
async function sendToTab(tabId, message) {
  const trySend = () =>
    browser.tabs.sendMessage(tabId, message).catch((err) => ({
      ok: false,
      error: err.message || String(err),
      _failed: true,
    }));

  let res = await trySend();
  if (res?.ok || !res?._failed) return res;

  // Inject content scripts and retry once
  try {
    if (browser.scripting?.executeScript) {
      await browser.scripting.executeScript({
        target: { tabId },
        files: CONTENT_SCRIPTS,
      });
    } else if (browser.tabs?.executeScript) {
      for (const file of CONTENT_SCRIPTS) {
        await browser.tabs.executeScript(tabId, { file });
      }
    }
    await new Promise((r) => setTimeout(r, 50));
    res = await trySend();
    if (res?._failed) {
      return {
        ok: false,
        error:
          res.error +
          " — reload the job page after loading the extension, then try again.",
      };
    }
    return res;
  } catch (injErr) {
    return {
      ok: false,
      error:
        (res?.error || "Content script unavailable") +
        ` (inject failed: ${injErr.message}). Reload the page and retry.`,
    };
  }
}

export async function activeTabId() {
  // lastFocusedWindow is reliable when the action originates from the sidebar
  // (currentWindow from a background page can miss the window the user is using).
  let tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs[0]) {
    tabs = await browser.tabs.query({ active: true, currentWindow: true });
  }
  return tabs[0]?.id;
}

/**
 * Import CV text from the active tab if it is a Google Doc (or Drive preview).
 * Read-only: uses export endpoint with session cookies, never mutates the Doc.
 */
export async function importCvFromActiveTab(tabId) {
  const tab = await browser.tabs.get(tabId);
  const url = tab?.url || "";
  const { parseDocsUrl, exportCvPlainText } = await import("./google-drive.js");
  const fileId = parseDocsUrl(url);
  if (!fileId) {
    throw new Error(
      "Active tab is not a Google Docs/Drive file. Open your CV in Docs or paste a Docs URL."
    );
  }
  const name = tab.title?.replace(/\s*[-–—]\s*Google Docs.*$/i, "").trim() || "Google Doc";
  return exportCvPlainText(fileId, { name });
}
