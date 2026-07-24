# Design note — manual "cookie backup" for stuck rate limits

Status: **BUILT** (2026-07-16). Shipped as `ClaudeSessionUsage.cs` plus a
"Refresh from Claude app" button on the Limits page. Both blockers the earlier
validation hit turned out to be surmountable — see "Resolution" at the bottom.
The rest of this note is the original design, kept for context.

> **Update 2026-07-22:** the header probe and the scoped-weekly estimator this
> note references were removed. Following the approach proven by community
> trackers (usage-monitor-for-claude and friends), the tracker now simply polls
> the OAuth usage endpoint every ~3 minutes (gently while the user is away),
> honors a 429's Retry-After bounded to 3–15 minutes, and shows only the
> server's own numbers. The cookie backup below remains as the manual fallback
> for a genuinely stuck endpoint.

## The problem it would solve

The Limits page reads plan usage from the Anthropic **OAuth usage endpoint**
(`GET https://api.anthropic.com/api/oauth/usage`). That endpoint rate-limits
**per account**: once tripped it returns `429` with a `Retry-After` up to ~1 hour,
and every retry inside the window keeps it closed. When an account is in that
cooldown, one number in particular has no other source: the **per-model "weekly
scoped" limit** (e.g. *Weekly · Fable*).

We already mitigate most of this (see `ClaudeLimitsService.cs`):

- **Pacing** — the signed-in account is fetched at most every few minutes,
  background accounts far less often, so we stop tripping the throttle.
- **Cooldown** — a `429`'s `Retry-After` is honored per account; we don't ask
  again until it passes.
- **Header-probe fallback** — during a cooldown, a minimal one-token
  `POST /v1/messages` call returns `anthropic-ratelimit-unified-*` response
  headers carrying the live **5-hour** and **all-models weekly** utilization, so
  the two headline limits stay fresh without the usage endpoint.

What the header probe **cannot** give is the per-model scoped weekly — those
headers only expose unified 5h + 7d (all-models). Verified: probing as the Fable
model does not make the `7d` header reflect the Fable-scoped weekly; it stays the
all-models value. So during a cooldown, the scoped weekly rows show their last
snapshot until the endpoint reopens (then they refresh automatically).

This backup tool closes that last gap by reading the scoped weekly the same way
the official Claude desktop app does — through claude.ai's cookie-authenticated
API, which is a **separate rate-limit bucket** and stays live even while the
OAuth usage endpoint is throttled.

## Why this is a manual, one-time tool — not a background feed

- It borrows the user's **claude.ai web session**, which is broader-scoped than
  the Claude Code OAuth token (the session can do anything the user can on
  claude.ai; the token essentially only reads usage). A background loop replaying
  that session is a large blast radius; a conscious, per-use "my limits look
  stuck — fetch them the other way" button is defensible.
- The endpoint is **private/undocumented** and sits behind Cloudflare bot
  protection aimed at exactly this kind of non-browser replay. Treat it as
  best-effort and expect it to break without notice.
- Keep cookies **in memory only** — decrypt, use for one request, discard. Never
  persist them to `accounts.json` or anywhere else.

## Feasibility findings (verified on this machine, 2026-07)

- **Claude desktop app is the MSIX Store build.** Its data lives under
  `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\`, NOT
  the `%APPDATA%\Claude` path `DesktopAppCredentials` currently checks. (That
  wrong path is a separate pre-existing bug — the desktop-managed OAuth account
  is never actually adopted. Worth fixing independently.)
- **Its cookie store is decryptable with code we already have.** The cookie DB is
  `…\Claude\Network\Cookies` (Chromium SQLite). Its `Local State` has a plain
  `os_crypt.encrypted_key` and **no** `app_bound_encrypted_key`, so the exact
  DPAPI + AES-256-GCM ("v10") routine in `DesktopAppCredentials.cs` decrypts the
  cookie values unchanged.
- **The browser path is effectively blocked.** Chrome on this machine has
  `os_crypt.app_bound_encrypted_key` set (app-bound encryption); DPAPI alone
  won't decrypt Chrome cookies. So this tool depends on the **Claude desktop app
  being installed**, not on a browser.
- The account's org UUID (needed for the claude.ai usage URL) is already known
  from the profile we fetch (`oauthAccount.organizationUuid`, e.g.
  `00000000-1111-2222-3333-444444444444`).

## Implementation sketch

1. **Locate the store.** MSIX path above; also accept a plain
   `%APPDATA%\Claude\Network\Cookies` for a non-Store install. Bail cleanly if
   absent (tool simply unavailable).
2. **Read the os_crypt key.** Reuse `ReadOsCryptKey` from `DesktopAppCredentials`
   against the app's `Local State`.
3. **Pull the claude.ai cookies.** Open the `Cookies` SQLite DB read-only
   (`Microsoft.Data.Sqlite`, or copy the file first — Chromium keeps it locked
   while the app runs). Select `name, encrypted_value` from `cookies` where
   `host_key` matches `.claude.ai`. Decrypt each `encrypted_value` with
   `DecryptOsCrypt`. The session cookies of interest are the ones the web app
   sends to its API (e.g. `sessionKey` / `__Secure-*`); grab all `.claude.ai`
   cookies and forward them rather than guessing names.
4. **Call the claude.ai usage API.** Replay the request the desktop app makes —
   `Cookie:` header with the decrypted pairs, plus a browser-like `User-Agent`,
   `Origin: https://claude.ai`, `Referer`, and whatever anti-CSRF header the app
   sends. Exact path/shape must be captured from the app's traffic (see below);
   it is org-scoped and returns the same limit set as the OAuth endpoint,
   including `weekly_scoped`.
5. **Map into `StoredLimit`.** Reuse `ParseLimits`' kind→label mapping so the
   scoped weekly (`weekly_scoped` → model display name) lands identically to the
   OAuth path. Merge into the `Limits` of the account whose stored org UUID
   matches the session's `lastActiveOrg` cookie — **not** the account currently
   shown: the desktop app may be signed into a different account, and writing
   the session's numbers onto the shown card poisons it until the next full
   snapshot (seen in the wild 2026-07-17). If no tracked account matches the
   session's org, refuse and say so. Stamp `LastFetchedMs`, render.
6. **UI.** A single explicit button on the Limits page — e.g. "Limits look stuck?
   Fetch from the Claude app session" — with a one-line explanation that it reads
   the desktop app's claude.ai session locally, one time. Show success/failure
   inline. No auto-invocation.

### Capturing the endpoint shape

The one unknown is the exact claude.ai usage URL and required headers. Capture it
once from the running desktop app: proxy its traffic (mitmproxy/Fiddler with the
app trusting the proxy cert) or inspect its renderer devtools, and record the
request it issues for the usage/limits view. Pin that shape in the code with a
comment noting it's reverse-engineered and may change.

## Validation results (2026-07-16) — TWO hard blockers found

A throwaway probe (`scratchpad/cookieprobe`) tested the mechanism end to end:

1. **os_crypt key extraction — WORKS.** The DPAPI-wrapped key decrypts to 32
   bytes with the existing `DesktopAppCredentials` routine. No app-bound
   encryption in the way. The crypto half is solved.
2. **Reading the Cookies DB while the app runs — BLOCKED at the OS level.** The
   Claude app holds `Network\Cookies` open with an **exclusive share mode** (no
   `FILE_SHARE_READ`). Consequences, all observed:
   - `File.Copy` → `IOException` (file in use).
   - Shared-read `FileStream` (`FileShare.ReadWrite | Delete`) → still a sharing
     violation; the app's own open denies read sharing, which no reader can
     override.
   - SQLite `immutable=1` read-only (takes no locks) → `SQLite Error 14: unable
     to open database file`. The block is the OS `CreateFile`, below SQLite.

   So the cookies are only readable when **the Claude app is fully closed**
   (VSS snapshot is the only live alternative — admin-only, heavy, out of scope).
   That defeats the core use case: a "my limits look stuck, fetch them the other
   way" button can't require quitting the very app you're comparing against.
3. **The claude.ai usage endpoint shape is still unknown.** Not in the app's
   logs, HTTP cache, IndexedDB, Local Storage, or Code Cache (all searched).
   Discovering it needs live traffic capture (proxy the app) — brute-forcing
   claude.ai's private, Cloudflare-fronted API risks flagging the account.

**Bottom line:** the tool is blocked on two independent hard problems (exclusive
file lock while running + unknown Cloudflare endpoint), for the narrow gap of one
number during a throttle. Recommended **against building** unless both the app is
reliably closed at fetch time AND the endpoint is captured from live traffic.

## Risks / reasons not to build it

- Undocumented endpoint + Cloudflare bot protection → brittle; likely the first
  thing to break, and could flag the account.
- Broader credential (web session) than the rest of the app handles.
- Only fills a narrow gap (scoped weekly, only during a cooldown, which pacing
  now makes uncommon). The honest **"Force refresh limits"** button — retry the
  OAuth endpoint if not throttled, otherwise header-probe and clearly show the
  scoped weekly's age + auto-refresh time — solves the user-facing confusion
  without any of this.

## Decision log

- 2026-07-16: Wrote this up instead of building. Plan: rely on pacing + cooldown
  + header-probe; wait to confirm the scoped weekly self-heals when the OAuth
  cooldown expires. Build this only if that proves insufficient in practice.
- 2026-07-16 (later): The OAuth endpoint did NOT reopen at cooldown expiry — it
  re-threw 429 with a fresh ~58 min window, because active Claude Code sessions
  on the same account also poll it. Probed the cookie path to build the backup;
  found the two blockers above (exclusive file lock + unknown endpoint). Did NOT
  build. Left the header-probe (5h + all-models weekly) as the working fallback;
  the scoped weekly refreshes only when the OAuth endpoint has a quiet moment.

## Resolution (2026-07-16, built)

Both "hard blockers" fell:

1. **Unknown endpoint — SOLVED.** Blocker #3 searched the app's runtime data
   (logs, cache, IndexedDB) but not the app's own JavaScript. The URL is a plain
   literal in `resources/app.asar`:
   `${mainWindowUrl}/api/organizations/${orgUuid}/usage?skip_spend=1` → i.e.
   `https://claude.ai/api/organizations/{org}/usage?skip_spend=1`. The response
   is the *same* shape as the OAuth usage endpoint (`kind`/`percent`/`severity`/
   `resets_at`/`scope.model.display_name`), so `ParseLimits` maps it unchanged,
   scoped weekly included.
2. **Exclusive file lock — ACCEPTED, not beaten.** The lock is real (verified
   again). The tool simply requires the desktop app to be quit; the failed
   `File.Copy` is the "app still open" probe and drives a clear UI message. A
   manual, user-invoked button makes that requirement reasonable.

Other findings baked into the implementation:

- **os_crypt key is under the MSIX profile**, not `%APPDATA%\Claude`:
  `…\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\{Local State, Network\Cookies}`.
  `ClaudeSessionUsage` checks the MSIX path first, then the plain path.
- **Forward all ASCII `.claude.ai` cookies** (analytics cookies decrypt to
  non-ASCII bytes and can't ride an HTTP header — dropped). `sessionKey` must be
  present; `lastActiveOrg` supplies the org UUID for free.
- **User-Agent must be the desktop app's Electron UA** (`…Claude/1.x …
  Electron/…`). `cf_clearance` is bound to the UA that minted it; a generic
  browser UA gets a 403 at Cloudflare. This cost one debug cycle.
- Cookies are read, used for one request, and never persisted. On success the
  fetch counts as a full snapshot (stamps `LastSnapshotMs`, clears the cooldown).
