# 0006: Store the theme preference on the user row

- Status: Accepted
- Date: 2026-09-10

## Context

Assembly-line issue #11 asks for a light/dark/system toggle whose fourth acceptance criterion is
"preference is saved to the user's account and applies when signing in on another device". A
browser-local store (`localStorage`, a cookie) satisfies the first three criteria and fails the
fourth, so the preference has to be server state. The realistic options were a new `user_settings`
table keyed by user id, a `jsonb` settings blob on `users`, and a single typed column on `users`.
There is exactly one setting today and no second one in the request; the out-of-scope list
(time-of-day switching, per-page overrides) rules out the shapes that would need a blob.

## Decision

`users` gets one additive column, `theme`, of a new Postgres enum `theme_preference` with the
values `light`, `dark` and `system`, `not null default 'system'` (`src/db/schema.ts`, migration
`drizzle/0002_user_theme_preference.sql`, additive per ADR 0004 — no existing row is rewritten,
they inherit the default). The column is part of the `User` API model (`src/schemas/auth.ts`), so
every response that already carries a user — register, login and `GET /auth/me` — carries the
preference too and the web needs no second request to render the right theme on load. It is written
only through `PATCH /auth/me` with the body `{ theme }`, which is bearer-authenticated and resolves
the row from `currentUser(req).id` alone: there is no user id in the path, so no request can reach
another account's preference. `system` is stored, not resolved: resolving `system` to a concrete
theme is the browser's job (`prefers-color-scheme`), and the API never guesses on behalf of a device
it cannot see.

## Consequences

- The web reads the theme from the session user it already has, so there is no extra round trip and
  no flash of the wrong theme after sign-in on a new device.
- A second user-level setting will want the same treatment (another column, another key in the
  `PATCH /auth/me` body). Past two or three, this ADR should be superseded by one that introduces a
  settings table or blob; one column each does not scale to a settings page.
- Adding an enum value later (say `high-contrast`) is an `ALTER TYPE ... ADD VALUE`, which is
  additive and allowed, but removing one is not: a value shipped here is permanent for the life of
  the type.
- `tests/db/schema.test.ts` now expects seven enums, and any test asserting the whole user payload
  has to include `theme`; `tests/api/auth.test.ts` covers the default, the round trip through a
  second login, the `400` on an unknown value and the `401` without a token.
- Rollback of the API deploy is safe on its own: an older API simply ignores the column, and the
  column keeps its default for rows written meanwhile.
