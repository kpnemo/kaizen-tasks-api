# Kaizen Tasks API reference

Generated from `openapi.json` by `npm run openapi`. Do not edit by hand.

Base path: `/api/v1`

Paths below are relative to the base path. Success responses are `{ data, meta }`; errors are `{ error: { code, message, details?, requestId } }`.

## POST /admin/seed-reset

Delete and recreate the demo user's fixtures

Mounted only when ADMIN_TOKEN is configured. A wrong or missing token returns NOT_FOUND so the route is invisible to guessing.

Auth: none

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| x-admin-token | header | string | yes | Facilitator token |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Fixtures recreated | object |
| 404 | NOT_FOUND | ErrorEnvelope |

## POST /auth/login

Log in with email and password

Returns a 15-minute access token. Also sets the httpOnly `kaizen_refresh` cookie scoped to `/api/v1/auth`.

Auth: none

**Request body** (`application/json`)

| Field | Type | Required |
|---|---|---|
| email | string (email) | yes |
| password | string | yes |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Logged in | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |

## POST /auth/logout

Revoke the refresh token and clear the cookie

Auth: none

**Responses**

| Status | Description | Body |
|---|---|---|
| 204 | Logged out |  |

## GET /auth/me

Current user

Auth: bearer access token

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | The authenticated user | object |
| 401 | UNAUTHORIZED | ErrorEnvelope |

## PATCH /auth/me

Update the current user's preferences

Saves the theme preference on the account, so it follows the user to another device or browser.

Auth: bearer access token

**Request body** (`application/json`)

| Field | Type | Required |
|---|---|---|
| theme | ThemePreference | yes |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | The updated user | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |

## POST /auth/refresh

Rotate the refresh cookie and issue a new access token

Reads the `kaizen_refresh` cookie. The old refresh token is invalidated.

Auth: none

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | New access token | object |
| 401 | UNAUTHORIZED | ErrorEnvelope |

## POST /auth/register

Register a new user

Open self-registration. Also sets the httpOnly `kaizen_refresh` cookie scoped to `/api/v1/auth`.

Auth: none

**Request body** (`application/json`)

| Field | Type | Required |
|---|---|---|
| email | string (email) | yes |
| password | string | yes |
| displayName | string | yes |

**Responses**

| Status | Description | Body |
|---|---|---|
| 201 | Registered | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 409 | CONFLICT | ErrorEnvelope |

## POST /feature-requests

File a feature request as a GitHub issue

Mounted only when GITHUB_TOKEN and GITHUB_REPO are configured. The issue is labeled `feature-request` and carries the submitter's display name. With `conversationId`, the issue body also carries the interview's self-score and transcript, and the conversation becomes `filed`.

Auth: bearer access token

**Request body** (`application/json`)

| Field | Type | Required |
|---|---|---|
| title | string | yes |
| problem | string | yes |
| proposedBehavior | string | yes |
| acceptanceCriteria | string | yes |
| outOfScope | string | no |
| conversationId | string (uuid) | no |

**Responses**

| Status | Description | Body |
|---|---|---|
| 201 | Issue created | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |
| 409 | CONFLICT | ErrorEnvelope |
| 502 | UPSTREAM_ERROR | ErrorEnvelope |

## GET /feature-requests/conversation

Get the caller's open interview conversation

Returns the caller's conversation whose status is `open` or `ready`. `NOT_FOUND` when there is none, which is how the web knows to start one.

Auth: bearer access token

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | The caller's conversation | object |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |

## POST /feature-requests/conversation

Start a new interview conversation

Abandons any `open` or `ready` conversation the caller has, then creates one whose first assistant message is the fixed greeting. No body, no model call.

Auth: bearer access token

**Responses**

| Status | Description | Body |
|---|---|---|
| 201 | The new conversation | object |
| 401 | UNAUTHORIZED | ErrorEnvelope |

## POST /feature-requests/conversation/{id}/messages

Send one answer and stream the assistant's reply

`skip: true` records `(skipped)` as the user message and tells the model the PM skipped; the submitted `content` is ignored, and the turn still counts. Ownership, status and rate-limit failures happen before the stream starts and are ordinary JSON error envelopes. Once the stream has started a failed turn is an `error` event and nothing is persisted, so a resend is a clean retry.

Auth: bearer access token

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| id | path | string (uuid) | yes |  |

**Request body** (`application/json`)

| Field | Type | Required |
|---|---|---|
| content | string | yes |
| skip | boolean | no |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | The turn as Server-Sent Events: `delta` chunks in order, then one `state` or one `error`, then `done`. A `: ping` comment line is written every 15 seconds while waiting on the model. |  |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |
| 409 | CONFLICT | ErrorEnvelope |
| 429 | RATE_LIMITED | ErrorEnvelope |
| 503 | UNAVAILABLE | ErrorEnvelope |

## GET /health

Health check with the running commit SHA

Auth: none

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Healthy | object |
| 503 | UNAVAILABLE | ErrorEnvelope |

## GET /openapi.json

This OpenAPI document

Auth: none

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | The committed openapi.json | object |

## GET /tags

List the user's tags

Auth: bearer access token

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Tags ordered by name | object |
| 401 | UNAUTHORIZED | ErrorEnvelope |

## POST /tags

Create a tag

Auth: bearer access token

**Request body** (`application/json`)

| Field | Type | Required |
|---|---|---|
| name | string | yes |
| color | string | yes |

**Responses**

| Status | Description | Body |
|---|---|---|
| 201 | Created | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 409 | CONFLICT | ErrorEnvelope |

## PATCH /tags/{id}

Rename or recolor a tag

Auth: bearer access token

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| id | path | string (uuid) | yes |  |

**Request body** (`application/json`)

| Field | Type | Required |
|---|---|---|
| name | string | no |
| color | string | no |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Updated | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |
| 409 | CONFLICT | ErrorEnvelope |

## DELETE /tags/{id}

Delete a tag and its links

Auth: bearer access token

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| id | path | string (uuid) | yes |  |

**Responses**

| Status | Description | Body |
|---|---|---|
| 204 | Deleted |  |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |

## GET /tasks

List tasks

Top-level tasks unless `parentId` is given. Keyset pagination on (createdAt desc, id desc); pass `meta.nextCursor` back as `cursor`.

Auth: bearer access token

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| status | query | TaskStatus | no |  |
| tagId | query | string (uuid) | no |  |
| parentId | query | string (uuid) | no |  |
| limit | query | integer | no |  |
| cursor | query | string | no |  |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | A page of tasks | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |

## POST /tasks

Create a task or a step

Root creates enqueue an AI breakdown (aiStatus pending) unless AI is disabled or rate limited, in which case aiStatus is skipped with a reason. Child creates (parentId set) get aiStatus skipped. Only two levels are allowed.

Auth: bearer access token

**Request body** (`application/json`)

| Field | Type | Required |
|---|---|---|
| title | string | yes |
| description | string | no |
| parentId | string (uuid) | no |
| tagIds | string (uuid)[] | no |

**Responses**

| Status | Description | Body |
|---|---|---|
| 201 | Created | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |

## GET /tasks/{id}

Get a task with its children, tags, progress and AI fields

Auth: bearer access token

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| id | path | string (uuid) | yes |  |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | The task | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |

## PATCH /tasks/{id}

Update a task

`position` is a target index among siblings; affected siblings shift in the same transaction. `suggestionState` is valid only on AI-origin rows: suggested to accepted or dismissed, dismissed to accepted, accepted to dismissed.

Auth: bearer access token

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| id | path | string (uuid) | yes |  |

**Request body** (`application/json`)

| Field | Type | Required |
|---|---|---|
| title | string | no |
| description | string | null | no |
| status | TaskStatus | no |
| position | integer | no |
| suggestionState | SuggestionState | no |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Updated | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |

## DELETE /tasks/{id}

Delete a task and its children

Auth: bearer access token

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| id | path | string (uuid) | yes |  |

**Responses**

| Status | Description | Body |
|---|---|---|
| 204 | Deleted |  |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |

## POST /tasks/{id}/breakdown

Request an AI breakdown

Root tasks only. CONFLICT when a generation is already pending or running. RATE_LIMITED past the user or global hourly limit (details carry scope, limit, resetAt). UNAVAILABLE when AI is paused by the operator.

Auth: bearer access token

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| id | path | string (uuid) | yes |  |

**Responses**

| Status | Description | Body |
|---|---|---|
| 202 | Accepted; aiStatus is pending | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |
| 409 | CONFLICT | ErrorEnvelope |
| 429 | RATE_LIMITED | ErrorEnvelope |
| 503 | UNAVAILABLE | ErrorEnvelope |

## POST /tasks/{id}/suggestions/accept-all

Accept every suggested step

Auth: bearer access token

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| id | path | string (uuid) | yes |  |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Updated | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |

## POST /tasks/{id}/suggestions/dismiss-all

Dismiss every suggested step

Auth: bearer access token

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| id | path | string (uuid) | yes |  |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Updated | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |

## PUT /tasks/{id}/tags

Replace the task's tag set

Unknown or foreign tag ids give VALIDATION_ERROR.

Auth: bearer access token

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| id | path | string (uuid) | yes |  |

**Request body** (`application/json`)

| Field | Type | Required |
|---|---|---|
| tagIds | string (uuid)[] | yes |

**Responses**

| Status | Description | Body |
|---|---|---|
| 200 | Updated | object |
| 400 | VALIDATION_ERROR | ErrorEnvelope |
| 401 | UNAUTHORIZED | ErrorEnvelope |
| 404 | NOT_FOUND | ErrorEnvelope |
