# auth.md

You are an agent. This service supports **agentic registration**: discover → register → (claim if needed) → exchange for an access_token → call API → handle revocation. Follow the steps in order; do not skip ahead.

Examples use placeholder hosts: `https://api.service.example.com` (the resource server hosting the API you want to call) and `https://auth.service.example.com` (the authorization server that handles registration). Real services substitute their own.

## Step 1 — Discover

Discovery is two hops — you may have already done this.

The 401 response that pointed you here also carries a `WWW-Authenticate` header with the PRM URL:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://api.service.example.com/.well-known/oauth-protected-resource"
```

Pull the `resource_metadata` value from that header and fetch it (1a). If you don't have the 401 in hand, the conventional path on the resource server is `/.well-known/oauth-protected-resource`.

### 1a. Fetch the Protected Resource Metadata

```http
GET /.well-known/oauth-protected-resource
```

Response shape:

```json
{
  "resource": "https://api.service.example.com/",
  "resource_name": "Service",
  "resource_logo_uri": "https://service.example.com/logo.png",
  "authorization_servers": ["https://auth.service.example.com/"],
  "scopes_supported": ["api.read", "api.write"],
  "bearer_methods_supported": ["header"]
}
```

What each field tells you:

- `resource` — the canonical URL of the API you're trying to call. Use this as the `aud` when minting an ID-JAG.
- `resource_name` / `resource_logo_uri` — display name and logo for the service. Surface these to the user when asking for consent.
- `authorization_servers` — base URLs of the OAuth Authorization Server(s) for this resource. The `agent_auth` block lives on one of these (see 1b).
- `scopes_supported` — scopes the resource server understands. The access_token you receive at Step 5 will be scoped to some subset.
- `bearer_methods_supported` — how you'll send the access_token in Step 6 (`"header"` = `Authorization: Bearer …`).

### 1b. Fetch the Authorization Server metadata

```http
GET <authorization_servers[0]>/.well-known/oauth-authorization-server
```

Response shape:

```json
{
  "resource": "https://api.service.example.com/",
  "authorization_servers": ["https://auth.service.example.com/"],
  "scopes_supported": ["api.read", "api.write"],
  "bearer_methods_supported": ["header"],

  "issuer": "https://auth.service.example.com",
  "token_endpoint": "https://auth.service.example.com/oauth2/token",
  "revocation_endpoint": "https://auth.service.example.com/oauth2/revoke",
  "grant_types_supported": ["urn:ietf:params:oauth:grant-type:jwt-bearer"],

  "agent_auth": {
    "skill": "https://service.example.com/auth.md",
    "identity_endpoint": "https://auth.service.example.com/agent/identity",
    "claim_endpoint": "https://auth.service.example.com/agent/identity/claim",
    "events_endpoint": "https://auth.service.example.com/agent/event/notify",
    "identity_types_supported": [
      "anonymous",
      "identity_assertion",
      "service_auth"
    ],
    "identity_assertion": {
      "assertion_types_supported": ["urn:ietf:params:oauth:token-type:id-jag"]
    },
    "events_supported": [
      "https://schemas.workos.com/events/agent/auth/identity/assertion/revoked"
    ]
  }
}
```

The outer fields restate the PRM. The top-level OAuth endpoints (`issuer`, `token_endpoint`, `revocation_endpoint`, `grant_types_supported`) are standard [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) / [RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009) / [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523) fields. The `agent_auth` block is the profile-specific bootstrap surface — read it in full. Every field is relevant:

- `issuer` — the canonical issuer URL of this authorization server. Validate the `iss` claim of any token the AS signs against this.
- `token_endpoint` — where you exchange a service-signed identity assertion for an access_token (Step 5).
- `revocation_endpoint` — where you POST to revoke an access_token ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)).
- `grant_types_supported` — lists the grant types accepted at `/oauth2/token`. Currently just `urn:ietf:params:oauth:grant-type:jwt-bearer` ([RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523)), for exchanging your identity_assertion for an access_token (Step 5). The claim ceremony does **not** run through `/oauth2/token` — you complete it at `agent_auth.claim_endpoint` (Step 4), not by polling a grant here.
- `agent_auth.skill` — the URL of this document.
- `agent_auth.identity_endpoint` — where you POST to register (Step 3).
- `agent_auth.claim_endpoint` — where you POST to start a claim attempt (Step 4) and, at `/complete`, where you submit the `user_code` the user reads back to you.
- `agent_auth.events_endpoint` — where the provider POSTs a [Security Event Token (RFC 8417)](https://datatracker.ietf.org/doc/html/rfc8417) per [RFC 8935](https://datatracker.ietf.org/doc/html/rfc8935) push delivery to notify the service of upstream identity events. You don't call this; it tells you what to expect.
- `agent_auth.identity_types_supported` — which registration methods this service accepts. Pick yours from Step 2.
- `agent_auth.identity_assertion.assertion_types_supported` — which assertion types this service accepts under the `identity_assertion` shape (currently ID-JAG).
- `agent_auth.events_supported` — event schemas this service can ingest (currently revocation). Informational; you don't act on these directly.

## Step 2 — Pick a method

Use this decision tree:

1. **You have a session tied to a user identity and can exchange it for an ID-JAG, audience-bound to this service** → [identity_assertion + id-jag](#identity_assertion--id-jag).
2. **You have only the user's email** → [service_auth](#service_auth). Claim ceremony required.
3. **You have neither** → [anonymous](#anonymous). Claim ceremony optional; deferred until the user wants to take ownership.

For `identity_assertion`, check that your assertion type is in `agent_auth.identity_assertion.assertion_types_supported`, if not listed then stop. For `service_auth` and `anonymous`, `identity_types_supported` is informational — send the body and fall back on the `*_not_enabled` error if the service opted out.

## Step 3 — Register

Before sending an `identity_assertion` or `service_auth` body, surface the service's `resource_name` and `resource_logo_uri` (from Step 1a) and the scope set you'll be acting under, and confirm with the user. This is the user's only consent gate before their identity is asserted to the service. Skip this for `anonymous` — there is no user identity to assert.

### identity_assertion + id-jag

Before minting the ID-JAG, confirm your provider is on this service's trust list (publishing format is service-specific — check the AS metadata or service docs). If it isn't, fall back to `service_auth` or `anonymous`.

Mint the assertion with:

- `aud` = the `resource` from the PRM
- `iss` = your provider's issuer URL (must be on the trust list above)
- `email_verified: true` OR `phone_number_verified: true`
- Fresh `jti`
- Near-term `exp` (~5 minutes)
- `auth_time` — epoch seconds when the user last authenticated at your provider. **Required.** The service rejects ID-JAGs whose underlying user authentication is older than its `idJagMaxAuthAgeSeconds` window.

```http
POST /agent/identity
Content-Type: application/json

{
  "type": "identity_assertion",
  "assertion_type": "urn:ietf:params:oauth:token-type:id-jag",
  "assertion": "<your ID-JAG JWT>"
}
```

The response has two shapes depending on whether the service already has a delegation on file for `(iss, sub)`.

**No confirmation needed** — `(iss, sub)` is known, or the service JIT-provisioned a fresh user (no email/phone collision with existing accounts):

```json
{
  "id": "reg_...",
  "type": "identity_assertion",
  "identity": {
    "assertion": "<service-signed JWT>",
    "expires_at": "2026-05-04T13:00:00.000Z"
  },
  "scopes": ["api.read", "api.write"]
}
```

Keep `identity.assertion` and go to [Step 5](#step-5--exchange-the-assertion).

**Confirmation required (401)** — `(iss, sub)` is unknown but the ID-JAG's verified email or phone matched an existing account at the service. The service won't silently bind the delegation — the user has to confirm linking the provider identity to their account.

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: AgentAuth error="interaction_required", error_description="…"

{
  "error": "interaction_required",
  "error_description": "…",
  "id": "reg_...",
  "type": "identity_assertion",
  "scopes": { "post_claim": ["api.read", "api.write"] },
  "claim": {
    "token": "clm_...",
    "expires_at": "…",
    "url": "https://auth.service.example.com/agent/identity/claim",
    "attempt": {
      "verification_uri": "https://auth.service.example.com/agent-claim?token=...",
      "expires_at": "…"
    }
  }
}
```

Same `claim` block as the `service_auth` registration response. Hand the user `claim.attempt.verification_uri`; they sign in, see a confirmation page that names your provider ("**Acme Provider** is asking to link this account so the agent it runs can act on your behalf"), and the page reveals a `user_code`. They read it back to you, and you submit it with `claim.token` at `/agent/identity/claim/complete` (see [Step 4](#step-4--claim-ceremony)).

After the user confirms, the next presentation of an ID-JAG for the same `(iss, sub, aud)` is accepted directly — no confirmation needed.

**Login required (401)** — `auth_time` is missing or older than the service's max-age. The agent has to go back to its own provider, get the user to re-authenticate there (e.g., `prompt=login` on the provider's auth endpoint), and re-mint a fresh ID-JAG. This is distinct from the confirmation case above: nothing the user does at the service helps; the freshness has to be established upstream.

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: AgentAuth error="login_required", max_age="3600", error_description="…"

{
  "error": "login_required",
  "error_description": "auth_time is …s old; max allowed is 3600s. Re-authenticate at the provider and request a fresh ID-JAG.",
  "max_age": 3600
}
```

### service_auth

```http
POST /agent/identity
Content-Type: application/json

{
  "type": "service_auth",
  "login_hint": "user@example.com"
}
```

Response (200):

```json
{
  "id": "reg_...",
  "type": "service_auth",
  "scopes": { "post_claim": ["api.read", "api.write"] },
  "claim": {
    "token": "clm_...",
    "expires_at": "2026-05-21T17:31:25.994Z",
    "url": "https://auth.service.example.com/agent/identity/claim",
    "attempt": {
      "verification_uri": "https://auth.service.example.com/agent-claim?token=...",
      "expires_at": "2026-05-21T17:31:25.994Z"
    }
  }
}
```

No `identity_assertion` yet — the first claim attempt is bundled into the registration response under `claim.attempt`. Hand the user `claim.attempt.verification_uri` (it carries an opaque attempt token, never the `user_code`); they sign in there and the page reveals a `user_code` for them to read back to you. You then submit that code together with `claim.token` at `/agent/identity/claim/complete` (see [Step 4](#step-4--claim-ceremony)). `claim.token` is returned exactly once — hold it in memory for the duration of the ceremony; do not persist it past Step 4.

### anonymous

```http
POST /agent/identity
Content-Type: application/json

{ "type": "anonymous" }
```

Response (200):

```json
{
  "id": "reg_...",
  "type": "anonymous",
  "identity": {
    "assertion": "<service-signed JWT>",
    "expires_at": "2026-05-04T13:00:00.000Z"
  },
  "scopes": {
    "pre_claim": ["api.read"],
    "post_claim": ["api.read", "api.write"]
  },
  "claim": {
    "token": "clm_...",
    "expires_at": "2026-05-21T17:26:32.915Z",
    "url": "https://auth.service.example.com/agent/identity/claim"
  }
}
```

The `identity.assertion` exchanges at `/oauth2/token` for an access_token with `scopes.pre_claim` immediately. If you also want a human to take ownership and unlock `scopes.post_claim`, go to [Step 4](#step-4--claim-ceremony) — unlike service_auth, no attempt is pre-minted, so you start one at `/agent/identity/claim`. Otherwise skip to [Step 5](#step-5--exchange-the-assertion). `claim.token` is returned exactly once — hold it in memory for the duration of the ceremony; do not persist it past Step 4.

## Step 4 — Claim ceremony

The end goal: bind the registration to a signed-in user at the service. The `user_code` travels **service → user → you**: the user authenticates at the service, the service's claim page reveals a `user_code`, the user reads it back to you, and you submit it to finish. You never see the code until the user relays it, and the user never types a code you handed them. The ceremony is always the **service_auth** method — anonymous registrations are claimed this way too.

### 4a. Get the ceremony materials

For **service_auth** registrations, the first attempt is already minted — it's in `claim.attempt` of the Step 3 response. Skip to 4b.

For **anonymous** registrations (and to re-mint an expired attempt for either kind), ask the service to start one:

```http
POST /agent/identity/claim
Content-Type: application/json

{
  "type": "service_auth",
  "claim_token": "clm_...",
  "login_hint": "user@example.com"
}
```

Response (200):

```json
{
  "id": "reg_...",
  "type": "service_auth",
  "attempt": {
    "verification_uri": "https://auth.service.example.com/agent-claim?token=...",
    "expires_at": "2026-05-21T17:31:25.994Z"
  }
}
```

`type` is the claim method, not the registration kind — anonymous registrations are claimed via `service_auth` too. The `verification_uri` carries an opaque attempt token that identifies the registration without leaking the `user_code` (which the service never puts in this response). The `login_hint` binds the attempt to the human you intend the agent to act on behalf of — only that signed-in user can complete the ceremony, so a third party who intercepted the link can't claim the agent for themselves.

### 4b. Hand off to the user

Surface `attempt.verification_uri` to the user. Suggested copy:

> Open this link and sign in (or sign up). You'll see a 6-digit code on the page — read it back to me.
> https://auth.service.example.com/agent-claim?token=...

Be explicit that the code comes **from the page back to you** — they don't type anything you gave them. The user will:

1. Open `verification_uri`.
2. Authenticate with the service (existing user → sign in; new user → sign up and verify email, depending on the service).
3. Land on the claim page, see "you're signed in as <email>", and confirm. The page reveals the `user_code`.
4. Read the `user_code` back to you.

### 4c. Complete the claim

Submit the `user_code` the user read back, together with your `claim_token`:

```http
POST /agent/identity/claim/complete
Content-Type: application/json

{
  "claim_token": "clm_...",
  "user_code": "123456"
}
```

There is no polling and no claim grant at `/oauth2/token` — you drive completion directly here with the code the user relayed. (The page the user confirmed on calls a separate, session-gated `/agent/identity/claim/view` to reveal the code; you never call that.)

Response on success — the post-claim identity, returned exactly once: the service-signed `identity.assertion` plus a rotating `refresh_token`. There is no access_token here; mint one at [Step 5](#step-5--exchange-the-assertion).

```json
{
  "id": "reg_...",
  "status": "claimed",
  "identity": {
    "assertion": "<service-signed JWT>",
    "expires_at": "2026-05-21T18:31:25.994Z",
    "refresh_token": {
      "value": "<refresh token>",
      "expires_at": "2026-06-21T17:31:25.994Z"
    }
  }
}
```

Persist this response — it's the only time the `refresh_token` plaintext is handed back (see [Step 6](#step-6--use-the-access_token) for how it's used). Then exchange `identity.assertion` for an access_token at [Step 5](#step-5--exchange-the-assertion).

For **anonymous** flows, completing the claim **revokes** any pre-claim access_tokens you held, and the pre-claim `identity.assertion` is superseded by the one returned here — the new one carries the user's email/email_verified claims, the pre-claim one didn't. Drop the pre-claim credentials and use the post-claim identity.

While the user hasn't finished on the page yet, `/complete` returns `claim_not_confirmed` — wait and retry. If the user reads the code wrong, it returns `invalid_user_code` — ask them to read it again. If the `user_code` window closes (`user_code_expired`), re-call `POST /agent/identity/claim` for a fresh attempt and hand the user the new link; if that returns `claim_expired`, the outer claim window (typically 24h) has closed — restart at [Step 3](#step-3--register).

## Step 5 — Exchange the assertion

POST the `identity_assertion` to the AS metadata's `token_endpoint` with the [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523) JWT-bearer grant. The `resource` parameter is optional but recommended — it pins the access_token to the API you're calling.

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
&assertion=<identity_assertion>
&resource=https://api.service.example.com/
```

Response (200):

```json
{
  "access_token": "<token>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "api.read api.write"
}
```

Extract `access_token` and go to [Step 6](#step-6--use-the-access_token). The same `identity.assertion` can be re-used to mint additional access_tokens until it expires.

If `/oauth2/token` returns `invalid_grant`, your assertion is expired or revoked. Restart the flow at [Step 3](#step-3--register) to mint a fresh identity assertion (or refresh it — see [Step 6](#step-6--use-the-access_token)).

## Step 6 — Use the access_token

Present the `access_token` as a bearer token:

```http
GET /api/some-resource
Authorization: Bearer <access_token>
```

**Refresh.** When the access_token expires (`expires_in` seconds after issuance), re-call [Step 5](#step-5--exchange-the-assertion) with the same stored `identity.assertion` — the assertion outlives individual access_tokens. When the assertion itself expires, how you recover depends on how you registered:

- **service_auth (and claimed anonymous):** your stored response carries a `refresh_token`. Exchange it for a fresh assertion — which also rotates the refresh token:

  ```http
  POST /agent/identity
  Content-Type: application/json

  { "type": "refresh", "refresh_token": "<refresh token>" }
  ```

  The response is a registration with a fresh `identity.assertion` and a new `refresh_token`; persist it (the old refresh token is now spent) and return to [Step 5](#step-5--exchange-the-assertion). If it returns `invalid_refresh_token`, the token is expired or already used — restart at [Step 3](#step-3--register).

- **anonymous (pre-claim) and identity_assertion:** there is no refresh token — re-register at [Step 3](#step-3--register) (for identity_assertion, mint a fresh ID-JAG).

If you get a 401 on a previously-working access_token: try [Step 5](#step-5--exchange-the-assertion) once with the current assertion. If that also fails, discard the expired identity assertion, and restart at [Step 1](#step-1--discover).

Full API reference: `https://docs.service.example.com/`.

## Errors

Errors at `/agent/identity` and `/agent/identity/claim/*` use profile-specific codes (the registration ceremonies have no OAuth analog). Errors at `/oauth2/token` use OAuth-standard vocabulary per [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) / [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523).

| Code                                 | Where                                       | What to do                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anonymous_registration_disabled`    | `/agent/identity`                           | This service doesn't accept anonymous registration. Pick another method from Step 2.                                                                                    |
| `service_auth_registration_disabled` | `/agent/identity`                           | service_auth disabled here. Pick another method.                                                                                                                        |
| `issuer_not_enabled`                 | `/agent/identity` (ID-JAG)                  | Provider not on this service's trust list. Pick another method.                                                                                                         |
| `invalid_request`                    | `/agent/identity`, `/agent/identity/claim*` | Body shape or missing/invalid fields (incl. ID-JAG signature/`jti`/`aud`). Fix the input.                                                                               |
| `invalid_login_hint`                 | `/agent/identity` (service_auth), `…/claim` | `login_hint` isn't a valid email. Fix it.                                                                                                                               |
| `interaction_required` (401)         | `/agent/identity` (ID-JAG)                  | Step-up: ID-JAG matched an existing account but no `(iss, sub)` delegation yet. Body carries a `claim` block; run the ceremony (see [Step 4](#step-4--claim-ceremony)). |
| `login_required` (401)               | `/agent/identity` (ID-JAG)                  | `auth_time` missing or older than `max_age`. Re-authenticate at your provider (`prompt=login` or equivalent) and mint a fresh ID-JAG. The service can't help here.      |
| `invalid_refresh_token`              | `/agent/identity` (refresh)                 | Refresh token wrong, expired, or already used. Restart at Step 3.                                                                                                       |
| `invalid_claim_token`                | `/agent/identity/claim`                     | `claim_token` wrong. Restart at Step 3.                                                                                                                                 |
| `claim_revoked` (410)                | `/agent/identity/claim`                     | The claim was revoked. Restart at Step 3.                                                                                                                               |
| `too_many_attempts` (429)            | `/agent/identity/claim`                     | Too many live attempts on this claim. Wait for one to expire or complete.                                                                                               |
| `claim_expired` (410)                | `/agent/identity/claim`, `…/claim/complete` | The outer claim window closed before the user finished. Restart at Step 3.                                                                                              |
| `auth_method_disabled` (403)         | `/agent/identity/claim`, `…/claim/complete` | service_auth claim disabled for this environment. Pick another method.                                                                                                  |
| `claim_not_confirmed` (409)          | `/agent/identity/claim/complete`            | User hasn't approved on the page yet. Wait and retry.                                                                                                                   |
| `invalid_user_code` (401)            | `/agent/identity/claim/complete`            | Wrong code. Ask the user to re-read it off the page.                                                                                                                    |
| `user_code_expired` (410)            | `/agent/identity/claim/complete`            | The code's window closed. Re-call `/agent/identity/claim` for a fresh attempt.                                                                                          |
| `claim_denied` (403)                 | `/agent/identity/claim/complete`            | The user denied the claim. Start a new attempt only if appropriate.                                                                                                     |
| `already_claimed` (409)              | `/agent/identity/claim`, `…/claim/complete` | This registration is already claimed. Re-read the Step 3 response.                                                                                                      |
| `invalid_grant`                      | `/oauth2/token`                             | Assertion expired, revoked, replayed, or otherwise failed verification. Restart at [Step 3](#step-3--register) to mint a fresh one.                                     |
| `invalid_client`                     | `/oauth2/token`                             | `client_id` not recognized. Re-read AS metadata.                                                                                                                        |
| `unsupported_grant_type`             | `/oauth2/token`                             | `grant_type` must be `urn:ietf:params:oauth:grant-type:jwt-bearer`.                                                                                                     |
| `rate_limit_exceeded` (429)          | any                                         | Back off and retry; honor the `retry_after` field / `Retry-After` header.                                                                                               |

The `user_code` reaches you only when the user reads it back off the claim page; you submit it at `/agent/identity/claim/complete`. A wrong code returns `invalid_user_code` (ask the user to read it again), and `claim_not_confirmed` means the user hasn't approved on the page yet (wait and retry).

Retry policy:

- 5xx → exponential backoff, retry the same request.
- 4xx → do not retry the same payload; act on the table above.
- 401 on a previously-working access_token → retry [Step 5](#step-5--exchange-the-assertion) once with the current assertion. If that fails, restart at [Step 1](#step-1--discover).

## Revocation

Two independent layers can kill what you're holding:

- **Credential layer ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009), `revocation_endpoint`)** — agent-callable. POST `token=<access_token>&token_type_hint=access_token` (form-encoded) to the top-level `revocation_endpoint` to kill one access_token. 200 on success, idempotent. Your `identity_assertion` is intact; re-run [Step 5](#step-5--exchange-the-assertion) to mint a fresh access_token.
- **Registration layer ([RFC 8935](https://datatracker.ietf.org/doc/html/rfc8935) Security Event Token delivery, `agent_auth.events_endpoint`)** — provider-driven. The provider that minted your ID-JAG can POST a [SET (RFC 8417)](https://datatracker.ietf.org/doc/html/rfc8417) (`Content-Type: application/secevent+jwt`) to this service's `events_endpoint`. The service invalidates the identity assertion and every access_token derived from it. You don't call this; you discover it the next time `/oauth2/token` returns `invalid_grant` — restart at [Step 3](#step-3--register).

On a 401 for a previously-working access_token: try [Step 5](#step-5--exchange-the-assertion) once. If `/oauth2/token` succeeds, the credential was revoked at the credential layer and your fresh access_token works. If `/oauth2/token` returns `invalid_grant`, the registration was killed at the registration layer — restart at [Step 3](#step-3--register).
