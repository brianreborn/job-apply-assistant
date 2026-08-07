# Live testing guide

No automated test suite. Confidence comes from exercising real job sites.

## Smoke checklist

### 1. Load

- [ ] `about:debugging` → Load Temporary Add-on → `manifest.json` (v0.5.0+)
- [ ] Browser console: `[JobApply] background ready` (no module errors)
- [ ] Sidebar opens; create passphrase; unlock

### 2. Grok connectivity

- [ ] Options → set xAI key → Save  
  **or** log into x.com → Import from browser
- [ ] Paste a short CV + short fake JD → **Run analyze without clicking Save** (auto-persist)
- [ ] Audit shows `grok.analyze` when “combine prompts” is on (default), or `grok.analyze.hooks` then `grok.analyze.body` when off
- [ ] Cover letter intro shows **concrete aptitude** for the role (not generic fluff)
- [ ] ATS resume text has OBJECTIVE + SUMMARY that read as prose (not "Core strengths: a, b, c")
- [ ] ATS notes mention keyword hits; experience is structured
- [ ] JD with a recruiter email does **not** block analyze (JD PII auto-allowed)

### 3. PII gate

- [ ] Clear allowlist (or new vault), paste CV with email **without** saving profile
- [ ] After Save CV (or auto-save on Analyze), analyze should proceed (CV PII auto-approved)
- [ ] Empty profile fields (email/name) prefilled from CV when present
- [ ] With a blocked scenario, sidebar shows approve UI

### 4. Google (session — preferred)

- [ ] Sign into https://drive.google.com in this Firefox profile (personal account)
- [ ] Sidebar → **Enable Google** (no client ID)
- [ ] Badge shows `session` (email if detectable)
- [ ] Paste a Docs URL → Import **or** List Docs → Import **or** open Doc → **Import open Doc tab**
- [ ] Confirm Drive file unchanged (version history / modified time)
- [ ] Empty profile email/name prefilled from imported Doc when present
- [ ] Audit: `drive.export.session` / `drive.list` GET only

### 5. Form fill (live ATS)

Pick a public application form (Greenhouse/Lever demo or real open role):

- [ ] Capture JD from the posting page
- [ ] Analyze
- [ ] Open Apply form → Map fields → table shows name/email/**multiple experience rows** (not only job #1)
- [ ] Fill form → fields populate; **Submit is not clicked**
- [ ] Soft confirm appears if you submit immediately after fill
- [ ] Manually submit only if you intend to apply

### 6. Global session

- [ ] Open sidebar in window A; capture JD; leave draft mid-flow
- [ ] Open sidebar in window B → same JD/cover letter/status
- [ ] **New job** clears the active draft; CV/profile remain

### 7. Account rotation (optional)

- [ ] Force rate-limit or remove API key
- [ ] With one X account, exhaust → `NEED_MORE_ACCOUNTS` message
- [ ] Add second account → analyze succeeds

### 8. X audit trail

- [ ] With Grok via X session (or while browsing x.com), open Fill → audit filter **X / Twitter**
- [ ] Entries show purposes like `x.grok` / `x.api` / `x.xhr` with status codes
- [ ] Options → Export JSONL filtered to `x.com` for a full ops dump
- [ ] Confirm no cookie values or auth tokens appear in the export

## Useful debug

| Where | What |
|-------|------|
| Sidebar → Fill → Recent audit | Last operations (filter by channel) |
| Options → Audit export | Full JSONL |
| Firefox DevTools → Network | Compare with audit hosts (x.com, api.x.ai, googleapis) |
| Content console on job page | Content-script errors |

## Known limits

- SPA forms that rebuild DOM after fill may need a second Map/Fill.
- Custom combobox widgets are best-effort; native `<select>` is reliable.
- X Grok session endpoints change; prefer the xAI API for reliability.
- Captchas, multi-step Workday wizards, and file-upload resume fields are partial (text fields only; no auto file upload).
- Google Drive list via session cookies may fail on some accounts; Docs URL / open-tab export still works when signed in.
