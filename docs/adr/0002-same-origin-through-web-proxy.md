# 0002: Same-origin API through the web service's proxy

- Status: Accepted
- Date: 2026-09-08

## Context

The web app needs to call the API with a refresh token that browsers protect (httpOnly cookie)
and an access token in memory. Serving the API on its own public domain would require CORS with
credentials, a cookie domain shared across two hosts, and one more public surface to harden.
PRD decision D31 chose same-origin; this record covers the API side.

## Decision

The API has no public domain. On Railway the `web` service (a static site behind Caddy) proxies
`/api/*` to `http://api.railway.internal:3000` over private networking; locally, Vite's dev proxy
does the same to `http://localhost:3000`. The API pins `PORT=3000` and listens on host `::` so
IPv6-only private DNS resolution works.

The refresh token is a first-party cookie: `kaizen_refresh`, httpOnly, `SameSite=Lax`,
`Path=/api/v1/auth`, seven days, `Secure` outside development and test. Redis keys it by
`sha256(token)` (`refresh:<hash>`), never the raw value, so a Redis key listing yields nothing
usable. Access tokens are 15-minute HS256 JWTs sent as `Authorization: Bearer`. There is no CORS
middleware.

## Consequences

- No CORS configuration anywhere; a request from a foreign origin cannot carry the cookie.
- The API's health endpoint is reached through the web domain (`https://<web>/api/v1/health`),
  which is what the promote workflow and the smoke test use.
- `app.set("trust proxy", 1)` is required so `Secure` cookies and request logging see the
  original scheme and client behind Caddy.
- If the web service is down, the API is unreachable from outside; that is acceptable because
  the API has no consumers other than the web app.
