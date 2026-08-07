/**
 * LLM client: xAI Grok (primary) → X-session Grok → OpenAI (automatic fallback).
 * Any failure on a Grok path (404, rate limit, network, invalid key) falls through
 * so analysis remains robust. User-submitted data is never discarded by backend choice.
 */

import { bytesOf, extractJson, sleep } from "../lib/util.js";
import { getSecrets, getSettings, isUnlocked } from "./secure-store.js";
import { audit } from "./audit-log.js";
import {
  pickAccount,
  markAccountResult,
  needMoreAccountsError,
  listPool,
} from "./account-pool.js";
import { gateText } from "./pii-gate.js";

const XAI_URL = "https://api.x.ai/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
/** Free-tier friendly, widely available OpenAI model */
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/**
 * @param {{ system: string, user: string, purpose?: string, temperature?: number }} opts
 * @returns {Promise<{ text: string, json: any, backend: string, accountId?: string }>}
 */
export async function grokChat({ system, user, purpose = "grok.chat", temperature = 0.3 }) {
  if (!isUnlocked()) throw new Error("Vault locked");

  // PII gate on the user payload (CV + JD content)
  const gated = await gateText(user, { mode: "block" });
  const safeUser = gated.text;

  const settings = await getSettings();
  const secrets = await getSecrets();
  const errors = [];

  // --- 1) xAI official API ---
  if (secrets.xaiApiKey) {
    try {
      return await callXai({
        apiKey: secrets.xaiApiKey,
        model: settings.model || "grok-3",
        system,
        user: safeUser,
        purpose,
        temperature,
        piiGate: gated.piiGate,
      });
    } catch (err) {
      if (err.code === "PII_REVIEW_REQUIRED") throw err;
      errors.push(`xAI: ${err.message}`);
      await audit({
        purpose,
        channel: "api.x.ai",
        error: String(err.message),
        note: "Falling through to next backend",
      });
    }
  }

  // --- 2) X session Grok pool ---
  // If the public session endpoints are gone (404 for all paths), do not burn every
  // account — fall through to OpenAI immediately.
  const pool = await listPool();
  if (pool.length) {
    const tried = new Set();
    for (let attempt = 0; attempt < pool.length; attempt++) {
      const account = await pickAccount();
      if (!account || tried.has(account.id)) break;
      tried.add(account.id);
      try {
        const result = await callXSessionGrok({
          account,
          system,
          user: safeUser,
          purpose,
          piiGate: gated.piiGate,
        });
        await markAccountResult(account.id, { ok: true, status: 200 });
        return result;
      } catch (err) {
        if (err.code === "PII_REVIEW_REQUIRED") throw err;
        errors.push(
          `X@${account.username || account.label || account.id.slice(0, 6)}: ${err.message}`
        );
        await markAccountResult(account.id, {
          ok: false,
          status: err.status,
          error: err.message,
          rateLimit: err.rateLimit,
        });
        // Endpoint-level failure (session API shape gone) — skip remaining X accounts
        if (err.code === "X_SESSION_UNAVAILABLE" || err.status === 404) {
          await audit({
            purpose,
            channel: "x.com",
            error: String(err.message),
            note: "X session API unavailable; skipping remaining pool → OpenAI fallback",
          });
          break;
        }
        // Hard-stop rotation only for non-retryable client bugs
        if (err.status === 400 && /malformed|invalid json/i.test(err.message || "")) {
          break;
        }
      }
    }
  }

  // --- 3) Google Gemini API (free tier via Google AI Studio) ---
  if (secrets.geminiApiKey) {
    try {
      const result = await callGemini({
        apiKey: secrets.geminiApiKey,
        model: settings.geminiModel || "gemini-2.0-flash",
        system,
        user: safeUser,
        purpose,
        temperature,
        piiGate: gated.piiGate,
      });
      await audit({
        purpose,
        channel: "generativelanguage.googleapis.com",
        note: `Google Gemini succeeded after prior failure(s): ${errors.slice(0, 3).join(" | ") || "none"}`,
      });
      return result;
    } catch (err) {
      if (err.code === "PII_REVIEW_REQUIRED") throw err;
      errors.push(`Gemini: ${err.message}`);
      await audit({
        purpose,
        channel: "generativelanguage.googleapis.com",
        error: String(err.message),
        note: "Google Gemini fallback failed",
      });
    }
  }

  // --- 4) Microsoft / GitHub Models API (free tier via GitHub PAT or Azure OpenAI) ---
  if (secrets.msApiKey) {
    try {
      const result = await callMicrosoft({
        apiKey: secrets.msApiKey,
        endpoint: settings.msEndpoint,
        model: settings.msModel || "gpt-4o-mini",
        system,
        user: safeUser,
        purpose,
        temperature,
        piiGate: gated.piiGate,
      });
      await audit({
        purpose,
        channel: "models.inference.ai.azure.com",
        note: `Microsoft/GitHub Models succeeded after prior failure(s): ${errors.slice(0, 3).join(" | ") || "none"}`,
      });
      return result;
    } catch (err) {
      if (err.code === "PII_REVIEW_REQUIRED") throw err;
      errors.push(`Microsoft: ${err.message}`);
      await audit({
        purpose,
        channel: "models.inference.ai.azure.com",
        error: String(err.message),
        note: "Microsoft/GitHub Models fallback failed",
      });
    }
  }

  // --- 5) OpenAI automatic fallback ---
  if (secrets.openaiApiKey) {
    try {
      const result = await callOpenAi({
        apiKey: secrets.openaiApiKey,
        model: settings.openaiModel || DEFAULT_OPENAI_MODEL,
        system,
        user: safeUser,
        purpose,
        temperature,
        piiGate: gated.piiGate,
      });
      await audit({
        purpose,
        channel: "api.openai.com",
        note: `OpenAI fallback succeeded after prior failure(s): ${errors.slice(0, 3).join(" | ") || "none"}`,
      });
      return result;
    } catch (err) {
      if (err.code === "PII_REVIEW_REQUIRED") throw err;
      errors.push(`OpenAI: ${err.message}`);
      await audit({
        purpose,
        channel: "api.openai.com",
        error: String(err.message),
        note: "OpenAI fallback failed",
      });
    }
  }

  // --- 6) Keyless Public LLM Service (Zero credentials required) ---
  try {
    const result = await callKeylessLlm({
      system,
      user: safeUser,
      purpose,
      temperature,
      piiGate: gated.piiGate,
    });
    await audit({
      purpose,
      channel: "text.pollinations.ai",
      note: `Keyless public LLM succeeded after prior failure(s): ${errors.slice(0, 3).join(" | ") || "none"}`,
    });
    return result;
  } catch (err) {
    if (err.code === "PII_REVIEW_REQUIRED") throw err;
    errors.push(`KeylessLLM: ${err.message}`);
    await audit({
      purpose,
      channel: "text.pollinations.ai",
      error: String(err.message),
      note: "Keyless public LLM fallback failed",
    });
  }

  // Nothing worked — surface actionable guidance without losing prior pipeline state
  const detail = errors.length ? errors.join(" | ") : "no backends configured";
  const err = needMoreAccountsError(
    `All LLM backends failed (${detail}). Local cover letter and ATS structure have been generated.`
  );
  err.backendErrors = errors;
  throw err;
}

/** Helper for individual fetch timeouts */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Free keyless public LLM service.
 * Connects to a working free public LLM endpoint without requiring user access credentials.
 * Tries POST across candidate models with independent 45s timeouts, then GET fallback.
 */
async function callKeylessLlm({ system, user, purpose, temperature, piiGate }) {
  const promptText = `${system}\n\n---\n\n${user}`;
  const models = ["openai", "qwen", "mistral"];
  const errors = [];

  for (const model of models) {
    try {
      const postBody = JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        model,
        jsonMode: true,
      });

      const res = await fetchWithTimeout(
        "https://text.pollinations.ai/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: postBody,
        },
        45000
      );

      const text = await res.text();
      await audit({
        channel: "text.pollinations.ai",
        method: "POST",
        url: `https://text.pollinations.ai/ (${model})`,
        purpose: purpose + ".keyless",
        requestMeta: { bytes: bytesOf(postBody), piiGate, model },
        responseMeta: { status: res.status, bytes: bytesOf(text) },
        error: res.ok ? null : text.slice(0, 300),
      });

      if (res.ok && text.trim()) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          const json = extractJson(text);
          if (json) {
            return { text, json, backend: `keyless.pollinations.${model}` };
          }
        }
        if (parsed && !parsed.error) {
          const content = parsed.content || parsed.response || (typeof parsed === "string" ? parsed : text);
          const json = extractJson(content);
          return {
            text: typeof content === "string" ? content : text,
            json,
            backend: `keyless.pollinations.${model}`,
            raw: parsed,
          };
        }
      }
    } catch (err) {
      errors.push(`model ${model}: ${err.message}`);
    }
  }

  // Fallback to GET
  try {
    const url = `https://text.pollinations.ai/${encodeURIComponent(promptText.slice(0, 3000))}?json=true`;
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
      30000
    );

    const text = await res.text();
    await audit({
      channel: "text.pollinations.ai",
      method: "GET",
      url: "https://text.pollinations.ai/",
      purpose: purpose + ".keyless",
      requestMeta: { bytes: bytesOf(promptText), piiGate },
      responseMeta: { status: res.status, bytes: bytesOf(text) },
      error: res.ok ? null : text.slice(0, 300),
    });

    if (!res.ok) {
      const err = new Error(`Keyless LLM ${res.status}: ${text.slice(0, 150)}`);
      err.status = res.status;
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const json = extractJson(text);
      if (json) return { text, json, backend: "keyless.pollinations.get" };
    }
    const content = parsed?.content || parsed?.response || text;
    const json = extractJson(content);
    return {
      text: typeof content === "string" ? content : text,
      json,
      backend: "keyless.pollinations.get",
      raw: parsed,
    };
  } catch (err) {
    errors.push(`GET: ${err.message}`);
  }

  throw new Error(`Keyless LLM failed (${errors.join(" | ")})`);
}

/**
 * Google Gemini API — free tier via Google AI Studio key.
 * Tries requested model first; falls back to gemini-1.5-flash on 429 quota error.
 */
async function callGemini({ apiKey, model, system, user, purpose, temperature, piiGate }) {
  const primaryModel = model || "gemini-2.0-flash";
  const candidateModels = [primaryModel];
  if (!candidateModels.includes("gemini-1.5-flash")) candidateModels.push("gemini-1.5-flash");

  const isJson =
    /json/i.test(system || "") ||
    /json/i.test(user || "") ||
    /analyze|fieldmap|hooks|body/i.test(purpose || "");

  let lastErr = null;

  for (const targetModel of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: `${system}\n\n---\n\n${user}` }],
        },
      ],
      generationConfig: {
        temperature: temperature ?? 0.3,
        ...(isJson ? { responseMimeType: "application/json" } : {}),
      },
    };
    const bodyStr = JSON.stringify(body);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
      });

      const text = await res.text();
      await audit({
        channel: "generativelanguage.googleapis.com",
        method: "POST",
        url: `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent`,
        purpose: purpose + (purpose.includes("gemini") ? "" : ".gemini"),
        requestMeta: { bytes: bytesOf(bodyStr), piiGate, model: targetModel },
        responseMeta: { status: res.status, bytes: bytesOf(text) },
        error: res.ok ? null : text.slice(0, 300),
      });

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        if (!res.ok) {
          const err = new Error(`Gemini API ${res.status}: ${text.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }
        throw new Error("Gemini returned non-JSON response");
      }

      if (!res.ok || parsed.error) {
        const msg = extractErrorMessage(parsed) || `Gemini API ${res.status}: ${text.slice(0, 200)}`;
        const err = new Error(`Gemini (${targetModel}): ${msg}`);
        err.status = res.status;
        err.code = parsed.error?.code || null;

        // If quota exceeded or 429, try next candidate model
        if (res.status === 429 || /quota/i.test(msg)) {
          lastErr = err;
          continue;
        }
        throw err;
      }

      const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!content.trim()) {
        const reason = parsed.candidates?.[0]?.finishReason || "empty content";
        throw new Error(`Gemini (${targetModel}) response empty (${reason})`);
      }
      return {
        text: content,
        json: extractJson(content),
        backend: `generativelanguage.googleapis.com:${targetModel}`,
        raw: parsed,
      };
    } catch (err) {
      if (err.code === "PII_REVIEW_REQUIRED") throw err;
      lastErr = err;
    }
  }

  throw lastErr || new Error("Gemini API failed");
}

/**
 * Microsoft / GitHub Models API — free tier via GitHub PAT or Azure OpenAI.
 */
async function callMicrosoft({ apiKey, endpoint, model, system, user, purpose, temperature, piiGate }) {
  const targetModel = model || "gpt-4o-mini";
  const url = endpoint && endpoint.trim()
    ? endpoint.trim()
    : "https://models.inference.ai.azure.com/chat/completions";

  const body = {
    model: targetModel,
    temperature: temperature ?? 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  const isJson =
    /json/i.test(system || "") ||
    /json/i.test(user || "") ||
    /analyze|fieldmap|hooks|body/i.test(purpose || "");
  if (isJson) {
    body.response_format = { type: "json_object" };
  }
  const bodyStr = JSON.stringify(body);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "api-key": apiKey,
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: bodyStr,
  });

  const text = await res.text();
  const rateLimit = {
    remaining: res.headers.get("x-ratelimit-remaining"),
    reset: res.headers.get("x-ratelimit-reset"),
  };

  await audit({
    channel: "models.inference.ai.azure.com",
    method: "POST",
    url,
    purpose: purpose + (purpose.includes("microsoft") ? "" : ".microsoft"),
    requestMeta: { bytes: bytesOf(bodyStr), piiGate, model: targetModel },
    responseMeta: { status: res.status, bytes: bytesOf(text), rateLimit },
    error: res.ok ? null : text.slice(0, 300),
  });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (!res.ok) {
      const err = new Error(`Microsoft API ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    throw new Error("Microsoft LLM returned non-JSON");
  }

  if (!res.ok || parsed.error || parsed.errors) {
    const msg = extractErrorMessage(parsed) || `Microsoft API ${res.status}: ${text.slice(0, 200)}`;
    const err = new Error(`Microsoft: ${msg}`);
    err.status = res.status;
    err.code = parsed.code || parsed.error?.code || null;
    throw err;
  }

  const content = parsed.choices?.[0]?.message?.content || "";
  if (!content.trim()) {
    throw new Error("Microsoft API returned empty content");
  }
  return {
    text: content,
    json: extractJson(content),
    backend: "microsoft.azure.com",
    raw: parsed,
  };
}

async function callXai({ apiKey, model, system, user, purpose, temperature, piiGate }) {
  const body = {
    model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  const bodyStr = JSON.stringify(body);

  const res = await fetch(XAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: bodyStr,
  });

  const text = await res.text();
  const rateLimit = {
    remaining: res.headers.get("x-ratelimit-remaining"),
    reset: res.headers.get("x-ratelimit-reset"),
  };

  await audit({
    channel: "api.x.ai",
    method: "POST",
    url: XAI_URL,
    purpose,
    requestMeta: { bytes: bytesOf(bodyStr), piiGate, model },
    responseMeta: { status: res.status, bytes: bytesOf(text), rateLimit },
    error: res.ok ? null : text.slice(0, 300),
  });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (!res.ok) {
      const err = new Error(`xAI API ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    throw new Error("xAI returned non-JSON");
  }

  if (!res.ok || parsed.error || parsed.errors || (parsed.code && parsed.code !== 200)) {
    const msg = extractErrorMessage(parsed) || `xAI API ${res.status}: ${text.slice(0, 200)}`;
    const err = new Error(`xAI: ${msg}`);
    err.status = res.status;
    err.code = parsed.code || parsed.error?.code || null;
    throw err;
  }

  const content = parsed.choices?.[0]?.message?.content || "";
  return {
    text: content,
    json: extractJson(content),
    backend: "api.x.ai",
    raw: parsed,
  };
}

/**
 * OpenAI Chat Completions — automatic fallback when Grok paths fail.
 * Default model gpt-4o-mini is the freest reliable OpenAI option for this workload.
 */
async function callOpenAi({ apiKey, model, system, user, purpose, temperature, piiGate }) {
  const body = {
    model: model || DEFAULT_OPENAI_MODEL,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (
    /json/i.test(system || "") ||
    /json/i.test(user || "") ||
    /analyze|fieldmap|hooks|body/i.test(purpose || "")
  ) {
    body.response_format = { type: "json_object" };
  }
  const bodyStr = JSON.stringify(body);

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: bodyStr,
  });

  const text = await res.text();
  const rateLimit = {
    remaining: res.headers.get("x-ratelimit-remaining"),
    reset: res.headers.get("x-ratelimit-reset"),
  };

  await audit({
    channel: "api.openai.com",
    method: "POST",
    url: OPENAI_URL,
    purpose: purpose + (purpose.includes("openai") ? "" : ".openai"),
    requestMeta: { bytes: bytesOf(bodyStr), piiGate, model: body.model },
    responseMeta: { status: res.status, bytes: bytesOf(text), rateLimit },
    error: res.ok ? null : text.slice(0, 300),
  });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (!res.ok) {
      const err = new Error(`OpenAI API ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    throw new Error("OpenAI returned non-JSON");
  }

  if (!res.ok || parsed.error || parsed.errors || (parsed.code && parsed.code !== 200)) {
    const msg = extractErrorMessage(parsed) || `OpenAI API ${res.status}: ${text.slice(0, 200)}`;
    const err = new Error(`OpenAI: ${msg}`);
    err.status = res.status;
    err.code = parsed.code || parsed.error?.code || null;
    throw err;
  }

  const content = parsed.choices?.[0]?.message?.content || "";
  if (!content.trim()) {
    throw new Error("OpenAI API returned empty content");
  }
  return {
    text: content,
    json: extractJson(content),
    backend: "api.openai.com",
    raw: parsed,
  };
}

/**
 * X-session Grok via grok.x.com REST-ish endpoints.
 * Uses logged-in cookies. Endpoint shapes change; we try known paths and surface clear errors.
 */
async function callXSessionGrok({ account, system, user, purpose, piiGate }) {
  const prompt = `${system}\n\n---\n\n${user}`;
  const url = "https://grok.x.com/2/grok/add_response.json";
  const payload = {
    responses: [
      {
        message: prompt,
        sender: 1,
        promptSource: "",
        fileAttachments: [],
      },
    ],
    systemPromptName: "",
    grokModelOptionId: "grok-3",
    conversationId: null,
    returnSearchResults: false,
    returnCitations: false,
    promptMetadata: { promptSource: "NATURAL", action: "INPUT" },
    imageGenerationCount: 0,
    requestFeatures: { eagerTweets: false, serverHistory: false },
    enableSideBySide: false,
    toolOverrides: {},
  };
  const bodyStr = JSON.stringify(payload);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization:
        "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
      "x-csrf-token": account.ct0,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      cookie: `auth_token=${account.authToken}; ct0=${account.ct0}`,
      referer: "https://grok.x.com/",
      origin: "https://grok.x.com",
      "user-agent": account.userAgent,
    },
    body: bodyStr,
  });

  const text = await res.text();
  const remaining = res.headers.get("x-rate-limit-remaining");
  const reset = res.headers.get("x-rate-limit-reset");
  const rateLimit = {
    remaining: remaining != null ? Number(remaining) : null,
    resetAt: reset ? Number(reset) * 1000 : null,
  };

  await audit({
    channel: "x.com",
    method: "POST",
    url,
    accountId: account.id,
    purpose,
    requestMeta: {
      bytes: bytesOf(bodyStr),
      piiGate,
      username: account.username || null,
    },
    responseMeta: { status: res.status, bytes: bytesOf(text), rateLimit },
    error: res.ok ? null : text.slice(0, 300),
  });

  if (res.status === 429) {
    const err = new Error("X Grok rate limited");
    err.status = 429;
    err.rateLimit = rateLimit;
    throw err;
  }
  if (!res.ok) {
    // Fallback: try alternate X endpoints
    if (res.status === 404 || res.status === 400) {
      return callXGrokAlternate({ account, system, user, purpose, piiGate });
    }
    const err = new Error(`X Grok ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.rateLimit = rateLimit;
    throw err;
  }

  const content = parseGrokStreamOrJson(text);
  return {
    text: content,
    json: extractJson(content),
    backend: "x.session",
    accountId: account.id,
  };
}

/**
 * Alternate: use api.x.com / x.com grok paths if primary fails.
 */
async function callXGrokAlternate({ account, system, user, purpose, piiGate }) {
  const urls = [
    "https://api.x.com/2/grok/add_response.json",
    "https://x.com/i/api/2/grok/add_response.json",
  ];
  const prompt = `${system}\n\n${user}`;
  const bodyStr = JSON.stringify({
    responses: [{ message: prompt, sender: 1 }],
    grokModelOptionId: "grok-3",
  });

  let lastStatus = 404;

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization:
            "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
          "x-csrf-token": account.ct0,
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-active-user": "yes",
          cookie: `auth_token=${account.authToken}; ct0=${account.ct0}`,
          referer: "https://x.com/i/grok",
          origin: "https://x.com",
          "user-agent": account.userAgent,
        },
        body: bodyStr,
      });
      const text = await res.text();
      lastStatus = res.status;

      await audit({
        channel: "x.com",
        method: "POST",
        url,
        accountId: account.id,
        purpose: purpose + ".alt",
        requestMeta: {
          bytes: bytesOf(bodyStr),
          piiGate,
          username: account.username || null,
        },
        responseMeta: { status: res.status, bytes: bytesOf(text) },
        error: res.ok ? null : text.slice(0, 300),
      });

      if (res.ok) {
        const content = parseGrokStreamOrJson(text);
        return {
          text: content,
          json: extractJson(content),
          backend: "x.session.alt",
          accountId: account.id,
        };
      }
    } catch (e) {
      if (e.isApiError) throw e;
      /* continue to next alternate */
    }
  }

  const err = new Error(
    `X Grok session API unavailable (${lastStatus}). Prefer an OpenAI API key in Options for automatic fallback (or an xAI API key).`
  );
  err.status = lastStatus;
  err.code = "X_SESSION_UNAVAILABLE";
  throw err;
}

function extractErrorMessage(j) {
  if (!j || typeof j !== "object") return null;
  if (typeof j.error === "string") return j.error;
  if (j.error && typeof j.error.message === "string") return j.error.message;
  if (j.message && typeof j.message === "string") return j.message;
  if (j.error) return JSON.stringify(j.error);
  return null;
}

/**
 * Grok endpoints may return NDJSON / event stream chunks.
 */
function parseGrokStreamOrJson(text) {
  if (!text) return "";
  // Try whole JSON
  try {
    const j = JSON.parse(text);
    if (j.error || j.errors || (j.code && j.code !== 200 && !j.choices && !j.result)) {
      const msg = extractErrorMessage(j) || `API error code ${j.code}`;
      const err = new Error(msg);
      err.isApiError = true;
      throw err;
    }
    return (
      j?.message ||
      j?.result?.message ||
      j?.data?.message ||
      j?.choices?.[0]?.message?.content ||
      JSON.stringify(j)
    );
  } catch (e) {
    if (e.isApiError) throw e;
    /* stream */
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let acc = "";
  for (const line of lines) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      if (j.error || j.errors) {
        const msg = extractErrorMessage(j) || "Stream API error";
        const err = new Error(msg);
        err.isApiError = true;
        throw err;
      }
      const chunk =
        j?.result?.message ||
        j?.message ||
        j?.token ||
        j?.choices?.[0]?.delta?.content ||
        j?.choices?.[0]?.message?.content ||
        "";
      if (typeof chunk === "string") acc += chunk;
    } catch (e) {
      if (e.isApiError) throw e;
      acc += payload;
    }
  }
  return acc || text;
}

/** Small helper for retries with backoff */
export async function withRetry(fn, { retries = 2, baseMs = 800 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e.code === "PII_REVIEW_REQUIRED" || e.code === "NEED_MORE_ACCOUNTS") throw e;
      // Don't burn retries on hard client errors
      if (e.status === 401 || e.status === 403 || e.status === 404) throw e;
      if (i < retries) await sleep(baseMs * (i + 1));
    }
  }
  throw last;
}
