# Unified login (Cloudflare Access SSO)

One login for every Kirakon app. You authenticate **once** at Cloudflare's edge;
each app then signs you in automatically from Cloudflare's verified identity —
no per-app password screen.

## How it works

```
You ──▶ Cloudflare Access (one login: Google / email OTP)
            │  injects a SIGNED JWT: Cf-Access-Jwt-Assertion
            ▼
      nginx (Mac Mini) ──▶ app
                              │  app verifies CF's JWT signature (can't be forged)
                              │  → gets your email → upserts a user → issues its
                              │    own session token  →  you're in, no login screen
```

The app **verifies Cloudflare's signature** (against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), so a request that skips Cloudflare and hits the origin directly with a fake header is rejected. If CF Access isn't configured, the app falls back to normal password login — nothing breaks.

## 1. Cloudflare Access setup (once, in the dashboard)

In **Cloudflare Zero Trust → Access**:

1. **Settings → Authentication** — add a login method (Google, or One-time PIN to email).
2. **Access → Applications → Add a self-hosted application** for each hostname
   (or one app with a wildcard `*.kirakon.com`):
   - Application domain: `fin.kirakon.com` (repeat for each app).
   - **Policy:** Allow · Emails · `kondetiudaykiran@gmail.com` (add family/friends here later for T3).
3. Open the application → **Overview** → copy the **Application Audience (AUD) Tag**.
4. Your **team domain** is shown under Zero Trust → Settings → Custom Pages /
   the `*.cloudflareaccess.com` hostname, e.g. `kirakon.cloudflareaccess.com`.

## 2. Per-app config

Set in each app's `.env` and restart:

```
CF_ACCESS_TEAM_DOMAIN=kirakon.cloudflareaccess.com
CF_ACCESS_AUD=<the app's AUD tag>
```

Leave unset to disable SSO for that app (normal login stays).

## 3. What the code does (this app = the reference implementation)

- `server/services/cfAccess.js` — verifies the CF Access JWT (fetches + caches
  Cloudflare's JWKS, checks signature + audience + issuer), returns the email.
  No new npm dependencies (Node `crypto` + the existing `jsonwebtoken`).
- `GET /api/auth/cf` — verifies, upserts a user by email, issues the app's JWT.
  Returns `204` (not an error) when SSO is off or no valid assertion is present.
- Frontend `trySsoLogin()` runs on load when there's no local token: if `/api/auth/cf`
  returns a token, it signs in silently; otherwise the normal login page shows.

## 4. Rolling out to the other apps

Each Node app gets the same three pieces, adapted to its auth:
1. Copy `server/services/cfAccess.js` (identical).
2. Add a `/auth/cf`-style route that verifies → upserts a user by email → issues
   that app's session/JWT.
3. Have the frontend attempt the SSO endpoint on load before showing login.

Third-party apps (Jenkins, LiteLLM, FileVault) are still gated by the single CF
Access login; where supported they can consume the same header
(Jenkins: *HTTP Header / Reverse-Proxy Auth* plugin).

## Security notes

- Always verify the **JWT signature** (done here). Never trust the plaintext
  `Cf-Access-Authenticated-User-Email` header alone — it's spoofable if the
  origin is reachable without Cloudflare.
- Keep the origin reachable **only through the tunnel**, as a defence-in-depth
  layer on top of signature verification.
