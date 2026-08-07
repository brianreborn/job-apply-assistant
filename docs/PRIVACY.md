# Privacy & security

## Vault

- Passphrase-derived key: **PBKDF2** (250k iterations, SHA-256) → **AES-GCM-256**.
- Encrypted at rest in IndexedDB: xAI API key, Google OAuth tokens, X `auth_token` / `ct0`.
- Session key is **in memory only**; restarting Firefox locks the vault.

## Personal information → Grok

Outbound LLM payloads are scanned (`lib/redaction.js`) for emails, phones, SSN-like patterns, personal profile URLs, street addresses, DOB-like dates.

| Source | Treatment |
|--------|-----------|
| Profile fields you save | Allowed (explicit application data) |
| PII found in CV on Save/Google import | Allowed (you submitted the CV for applications) |
| PII-like tokens in a captured/saved job description | Allowed (application context you submitted — recruiter contacts, office addresses, etc.) |
| Other unvetted matches | **Blocked** until you approve in the sidebar |

Legal/EEO/salary fields are never auto-filled from inference alone.

Empty profile fields may be prefilled from contact lines found in a CV you saved — that still counts as data you submitted for application use.

## Google Drive

**Preferred path — browser session**

- Uses cookies already present for a personal Google account signed into this Firefox profile.
- Read-only GETs: Docs plain-text export, Drive download, optional Drive API list with SAPISIDHASH.
- No Google Cloud project, no OAuth client ID, no metadata writes.
- **Import open Doc tab** uses the same export path against the file id in the active tab URL.

**Optional path — OAuth**

Scopes requested:

- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/documents.readonly`

Operations: list files, get metadata, **export** Docs as `text/plain` or download plain text. No `files.update`, no permission changes, no metadata writes. Tokens with non-readonly scopes are refused.

## Audit trail

Every intentional network call to X, xAI, or Google is logged with:

- timestamp, channel, method, redacted URL, purpose
- request/response byte sizes, HTTP status, rate-limit headers when present
- account id (pool) when using X sessions
- PII gate outcome (`passed` / `blocked` / `partial`)

**Secondary capture** via `webRequest` for X, xAI, Google hosts:

- `onBeforeRequest` + `onCompleted` / `onErrorOccurred` pairing
- purpose classification for X (`x.grok`, `x.api`, `x.xhr`, …)
- initiator kind (`extension` vs `x-tab` vs `page`)
- duration and status; **never** cookies, auth headers, or request bodies

Static assets (images/fonts/styles) are skipped so the log stays ops-focused.

**Export:** Options → Audit → Export JSONL (optionally filter to `x.com` only for a pure Twitter ops trail).

Audit entries intentionally omit cookie values and full prompt bodies.
