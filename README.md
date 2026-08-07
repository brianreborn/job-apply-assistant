# JobApply Assistant

Firefox extension that automates **as much as possible** of job applications — CV distill, ATS-aware cover letters & resume text, and form fill — **without ever submitting** on your behalf.

Powered by **Grok / Gemini / Microsoft / OpenAI** (xAI API primary → X/Twitter session pool → **Google Gemini free tier** → **Microsoft / GitHub Models free tier** → **OpenAI fallback**). Full structured audit trail. Personal information only leaves the machine for the LLM after you explicitly submit it (CV/profile) or approve it.

## Features

| Capability | Detail |
|------------|--------|
| **LLM pipeline** | Analyze with multi-backend fallbacks: default **single-pass** (Options → combine prompts) or **two-pass** (hooks then body). Fallback order: xAI → X session Grok → **Google Gemini (free)** → **Microsoft / GitHub Models (free)** → **OpenAI**. Local structure only if all LLMs fail — CV/JD/profile are never discarded |
| **ATS strategy** | Aggressive but truthful: JD vocabulary mirroring, synonym expansion, front-loading, skills density packing, relevance-ordered experience — game the filter, keep employment facts honest |
| **ATS resume text** | Linear plain-text resume for paste fields (OBJECTIVE / SUMMARY / SKILLS / EXPERIENCE / EDUCATION). Assembled from pass-1 hooks + structured body — not a single freeform dump |
| **X account rotation** | Accounts uniquely keyed by **@username** (verify_credentials). Re-import updates cookies in place. Used when xAI is down before OpenAI fallback |
| **Google Docs/Drive CV** | **Zero-config session mode**: use your existing Firefox Google login (no Cloud project). Import from URL, Docs list, or the open Docs tab. Export plain text only — never writes Drive data |
| **Form automation** | Scan live pages (stable field ids, SPA comboboxes), map multi-row experience/education in document order, fill inputs; **never auto-submit**. Content scripts auto-inject if missing. Sidebar auto-saves draft fields before Analyze/Map/Fill |
| **PII gate** | Blocks unvetted personal data in outbound Grok payloads; CV paste and profile save count as explicit consent; empty profile slots auto-prefill from CV contact lines |
| **Audit trail** | Structured logs for X, xAI, Google, and pipeline events; webRequest request/response pairing for Twitter ops; JSONL export |
| **Global session** | One active application draft for the whole browser profile — same state in every window/tab/sidebar |

## Install (temporary add-on)

1. Open Firefox → `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Select `Projects/job-apply-assistant/manifest.json`
4. Open the **sidebar** (View → Sidebar → JobApply Assistant) or the toolbar popup

Requires **Firefox 115+**. Reload job pages once after loading if content-script actions fail (or just retry — the background will inject scripts).

## First-run setup

1. **Create vault passphrase** (sidebar) — encrypts X cookies, Google tokens, and API keys (PBKDF2 + AES-GCM).
2. **Options → LLM keys** (recommended):
   - **xAI API key** from [console.x.ai](https://console.x.ai) for Grok, **and/or**
   - **OpenAI API key** (automatic fallback when Grok session returns 404 / rate-limits / any error). Default model `gpt-4o-mini`.
   - Optionally import X sessions while logged into x.com (keyed by @username).
3. **Google (optional):** sign into [drive.google.com](https://drive.google.com) in this Firefox profile → sidebar **Enable Google**. No client ID required.
4. Paste or import a **CV**, fill **profile** contact fields (or let Save CV prefill them).

## Daily workflow

1. Open a job posting in a tab.
2. Sidebar → **Job** → **Capture from tab** (or paste the JD).
3. **Run analyze** — review cover letter, ATS resume text, ATS notes, structured experience.
4. Open the application form → **Map fields** → **Fill form**.
5. **You** review and click Submit on the site.
6. When switching postings, click **New job** (one global draft at a time).

## Privacy guarantees

- Google access is **read-only** (session export or `drive.readonly` / `documents.readonly`); tokens with write scopes are refused.
- Grok never receives unvetted PII; values in your CV (after Save/Import) and profile are treated as application inputs you submitted.
- Audit logs store metadata (URL host, purpose, status, byte sizes, initiator, duration) — not full request bodies with secrets.
- Vault locks when the background page is discarded (browser restart); re-enter passphrase.

See [docs/PRIVACY.md](docs/PRIVACY.md).

## Live testing

There is **no static unit-test harness**. Validate against real ATS pages (Greenhouse, Lever, Workday, etc.). See [docs/LIVE_TESTING.md](docs/LIVE_TESTING.md).

## Architecture

```
sidebar / popup / options
        │  messages
        ▼
background (ES modules)
  pipeline · grok-client · google-drive
  secure-store · account-pool · audit-log · pii-gate
  lib: prompts · ats-heuristics · ats-resume · field-mapper · cv-structure
        │  tabs.sendMessage (+ scripting inject fallback)
        ▼
content scripts (JD extract · form scan · fill · submit-guard)
```

Global application state lives in the background + IndexedDB (`currentAppId`). Every sidebar/popup instance reads and writes that single draft.

## Non-goals

- Auto-submit applications
- Mutating Google Drive files or metadata
- Shipping a unit/integration test suite for offline mock ATS pages
- Concurrent multi-job workflows (one draft; user is involved throughout)

## License

Use at your own risk. You are responsible for the accuracy of materials submitted to employers.
