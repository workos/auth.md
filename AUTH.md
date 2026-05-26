# auth.md

You are an agent. This service supports **agentic registration**: discover → register → (claim if needed) → call API → handle revocation. Follow the steps in order; do not skip ahead.

Examples use placeholder hosts: `https://api.service.com` (the resource server hosting the API you want to call) and `https://auth.service.com` (the authorization server that handles registration). Real services substitute their own.

## Step 1 — Discover

Discovery is two hops — you may have already done this.

The 401 response that pointed you here also carries a `WWW-Authenticate` header with the PRM URL:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://api.service.com/.well-known/oauth-protected-resource"
```

Pull the `resource_metadata` value from that header and fetch it (1a). If you don't have the 401 in hand, the conventional path on the resource server is `/.well-known/oauth-protected-resource`.

### 1a. Fetch the Protected Resource Metadata

```http
GET /.well-known/oauth-protected-resource
```

Response shape:

```json
{
  "resource": "https://api.service.com/",
  "resource_name": "Service",
  "resource_logo_uri": "https://service.com/logo.png",
  "authorization_servers": ["https://auth.service.com/"],
  "scopes_supported": ["api.read", "api.write"],
  "bearer_methods_supported": ["header"]
}
```

What each field tells you:

- `resource` — the canonical URL of the API you're trying to call. Use this as the `aud` when minting an ID-JAG.
- `resource_name` / `resource_logo_uri` — display name and logo for the service. Surface these to the user when asking for consent.
- `authorization_servers` — base URLs of the OAuth Authorization Server(s) for this resource. The `agent_auth` block lives on one of these (see 1b).
- `scopes_supported` — scopes the resource server understands. The credential you receive will be scoped to some subset; you don't request specific scopes during registration.
- `bearer_methods_supported` — how you'll send the credential in Step 5 (`"header"` = `Authorization: Bearer …`).

### 1b. Fetch the Authorization Server metadata

```http
GET <authorization_servers[0]>/.well-known/oauth-authorization-server
```

Response shape:

```json
{
  "resource": "https://api.service.com/",
  "authorization_servers": ["https://auth.service.com/"],
  "scopes_supported": ["api.read", "api.write"],
  "bearer_methods_supported": ["header"],

  "issuer": "https://auth.service.com",
  "token_endpoint": "https://auth.service.com/oauth2/token",
  "revocation_endpoint": "https://auth.service.com/oauth2/revoke",
  "grant_types_supported": ["urn:ietf:params:oauth:grant-type:jwt-bearer"],

  "agent_auth": {
    "skill": "https://service.com/auth.md",
    "registration_endpoint": "https://auth.service.com/agent/register",
    "claim_endpoint": "https://auth.service.com/agent/register/claim",
    "events_endpoint": "https://auth.service.com/agent/event/notify",
    "identity_types_supported": ["anonymous", "identity_assertion"],
    "identity_assertion": {
      "assertion_types_supported": [
        "urn:ietf:params:oauth:token-type:id-jag",
        "verified_email"
      ]
    },
    "events_supported": [
      "https://schemas.workos.com/events/agent/identity/assertion/revoked"
    ]
  }
}
```

The outer fields restate the PRM. The top-level OAuth endpoints (`issuer`, `token_endpoint`, `revocation_endpoint`, `grant_types_supported`) are standard [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) / [RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009) / [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523) fields. The `agent_auth` block is the profile-specific bootstrap surface — read it in full. Every field is relevant:

- `issuer` — the canonical issuer URL of this authorization server. Validate the `iss` claim of any token the AS signs against this.
- `token_endpoint` — where you exchange a service-signed identity assertion for an access_token (Step 5).
- `revocation_endpoint` — where you POST to revoke an access_token ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)).
- `grant_types_supported` — confirms this AS accepts `urn:ietf:params:oauth:grant-type:jwt-bearer` ([RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523)) at `/token`.
- `agent_auth.skill` — the URL of this document.
- `agent_auth.registration_endpoint` — where you POST to register (Step 3).
- `agent_auth.claim_endpoint` — where you POST the claim invite and OTP (Step 4).
- `agent_auth.events_endpoint` — where the provider POSTs a [Security Event Token (RFC 8417)](https://datatracker.ietf.org/doc/html/rfc8417) to notify the service of upstream identity events. You don't call this; it tells you what to expect.
- `agent_auth.identity_types_supported` — which registration methods this service accepts. Pick yours from Step 2.
- `agent_auth.identity_assertion.assertion_types_supported` — which assertion types this service accepts (ID-JAG, verified email, etc.).
- `agent_auth.events_supported` — security event schemas this service can ingest (currently revocation). Informational; you don't act on these directly.

## Step 2 — Pick a method

Use this decision tree:

1. **You have a session tied to a user identity and can exchange it for an ID-JAG, audience-bound to this service** → [identity_assertion + id-jag](#identity_assertion--id-jag).
2. **You have only the user's email** → [identity_assertion + email](#identity_assertion--email). Claim ceremony required.
3. **You have neither** → [anonymous](#anonymous). Claim ceremony optional; deferred until the user wants to take ownership.

Before sending: cross-check your choice against the `agent_auth` block. If the matching `*_supported` array doesn't list your method, this service won't accept that registration shape — pick another or stop.

## Step 3 — Register

Before sending an `identity_assertion` (either variant), surface the service's `resource_name` and `resource_logo_uri` (from Step 1a) and the scope set you'll be acting under, and confirm with the user. This is the user's only consent gate before their identity is asserted to the service. Skip this for `anonymous` — there is no user identity to assert.

### identity_assertion + id-jag

Before minting the ID-JAG, confirm your provider is on this service's trust list (publishing format is service-specific — check the AS metadata or service docs). If it isn't, fall back to `identity_assertion + email` or `anonymous`.

Mint the assertion with:

- `aud` = the `resource` from the PRM
- `iss` = your provider's issuer URL (must be on the trust list above)
- `email_verified: true` OR `phone_number_verified: true`
- Fresh `jti`
- Near-term `exp` (~5 minutes)

```http
POST /agent/register
Content-Type: application/json

{
  "type": "identity_assertion",
  "assertion_type": "urn:ietf:params:oauth:token-type:id-jag",
  "assertion": "<your ID-JAG JWT>"
}
```

Response (200):

```json
{
  "registration_id": "reg_...",
  "registration_type": "agent-provider",
  "identity_assertion": "<service-signed ID-JAG>",
  "identity_assertion_expires": "2026-05-04T13:00:00.000Z"
}
```

The service verified your ID-JAG and minted a service-signed identity assertion bound to the registration. Keep `identity_assertion` and go to [Step 5](#step-5--exchange-the-assertion).

### identity_assertion + email

```http
POST /agent/register
Content-Type: application/json

{
  "type": "identity_assertion",
  "assertion_type": "verified_email",
  "assertion": "user@example.com"
}
```

Response (200):

```json
{
  "registration_id": "reg_...",
  "registration_type": "email-verification",
  "claim_url": "https://auth.service.com/agent/register/claim",
  "claim_token": "clm_...",
  "claim_token_expires": "2026-05-21T17:31:25.994Z"
}
```

There is no identity assertion yet — the user has to read back an OTP first. The service has already emailed them. Keep `claim_token` and go to [Step 4](#step-4--claim-ceremony). `claim_token` is returned exactly once — hold it in memory for the duration of the ceremony; do not persist it past Step 4.

### anonymous

```http
POST /agent/register
Content-Type: application/json

{
  "type": "anonymous"
}
```

Response (200):

```json
{
  "registration_id": "reg_...",
  "registration_type": "anonymous",
  "identity_assertion": "<service-signed ID-JAG>",
  "identity_assertion_expires": "2026-05-04T13:00:00.000Z",
  "claim_url": "https://auth.service.com/agent/register/claim",
  "claim_token": "clm_...",
  "claim_token_expires": "2026-05-21T17:26:32.915Z",
  "post_claim_scopes": ["api.read", "api.write"]
}
```

You have a usable identity assertion immediately, at pre-claim scopes. Go to [Step 5](#step-5--exchange-the-assertion) to mint your first access_token. If you also want a human to take ownership and unlock `post_claim_scopes`, go to [Step 4](#step-4--claim-ceremony) — after claim completes, your existing access_tokens issued from this registration are upgraded in place. `claim_token` is returned exactly once — hold it in memory for the duration of the ceremony; do not persist it past Step 4.

## Step 4 — Claim ceremony

The end goal: get the user to read a 6-digit OTP back to you.

### 4a. Trigger the claim email (anonymous only)

Skip this for `email` registrations — the email was sent during Step 3.

```http
POST /agent/register/claim
Content-Type: application/json

{
  "claim_token": "clm_...",
  "email": "user@example.com"
}
```

Response (200):

```json
{
  "registration_id": "reg_...",
  "claim_attempt_id": "...",
  "status": "initiated",
  "expires_at": "..."
}
```

### 4b. Wait for the user's OTP

The user receives an email, clicks the link, sees a 6-digit OTP, reads it back to you. Surface this in your agent UI:

- Default ask: "Check your email and tell me the 6-digit code."
- If the user pastes the URL back instead of the code: "Open the link in your browser — the page will show a 6-digit code. Read it back to me."
- If the code is rejected: "That code didn't work — re-read it carefully, or open the email link again for a fresh one."

### 4c. Submit the OTP

```http
POST /agent/register/claim/complete
Content-Type: application/json

{
  "claim_token": "clm_...",
  "otp": "123456"
}
```

Response on success (anonymous):

```json
{ "registration_id": "reg_...", "status": "claimed" }
```

Your existing access_tokens minted from this registration keep working — their scope set is upgraded in place. No new identity assertion is issued; the one from Step 3 still resolves.

Response on success (email-verification):

```json
{
  "registration_id": "reg_...",
  "status": "claimed",
  "identity_assertion": "<service-signed ID-JAG>",
  "identity_assertion_expires": "..."
}
```

Keep `identity_assertion` and go to [Step 5](#step-5--exchange-the-assertion).

## Step 5 — Exchange the assertion

Trade the service-signed `identity_assertion` for an access_token at the standard `token_endpoint` using the [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523) JWT-bearer grant. Request body is form-encoded:

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
&assertion=<identity_assertion from Step 3 or 4>
&resource=https://api.service.com/
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

Extract `access_token` and go to [Step 6](#step-6--use-the-credential). The same `identity_assertion` can be re-used to mint additional access_tokens until it expires.

If `/oauth2/token` returns `invalid_grant`, your `identity_assertion` is expired or revoked — restart at [Step 3](#step-3--register) to mint a fresh one. If it returns `insufficient_user_authentication` ([RFC 9470](https://datatracker.ietf.org/doc/html/rfc9470)), the registration moved into a state requiring re-claim — restart at [Step 3](#step-3--register) and walk the claim ceremony again.

## Step 6 — Use the credential

Present the `access_token` as a bearer token:

```http
GET /api/some-resource
Authorization: Bearer <access_token>
```

**Refresh.** When the access_token expires (`expires_in` seconds after issuance), re-call [Step 5](#step-5--exchange-the-assertion) with the same `identity_assertion`. When the identity assertion itself expires or `/oauth2/token` returns `invalid_grant`, restart at [Step 3](#step-3--register). There is no OAuth refresh_token in this flow — the two-step pattern replaces it.

If you get a 401 on a previously-working access_token: try [Step 5](#step-5--exchange-the-assertion) once with the current assertion. If that also fails, drop everything and restart at [Step 1](#step-1--discover).

Full API reference: `https://docs.service.com/`.

## Errors

Errors at `/agent/register` and `/agent/register/claim/*` use profile-specific codes (the registration ceremonies have no OAuth analog). Errors at `/oauth2/token` use OAuth-standard vocabulary per [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) / [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523) / [RFC 9470](https://datatracker.ietf.org/doc/html/rfc9470).

| Code                               | Where                            | What to do                                                                                                                                                             |
| ---------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anonymous_not_enabled`            | `/agent/register`                | This service doesn't accept anonymous. Pick another method from Step 2.                                                                                                |
| `verified_email_not_enabled`       | `/agent/register`                | Email verification disabled here. Pick another method.                                                                                                                 |
| `issuer_not_enabled`               | `/agent/register`                | Provider not on this service's trust list. Pick another method.                                                                                                        |
| `invalid_request`                  | `/agent/register`                | Body shape, missing claims, ID-JAG signature/`jti`/`aud` problems, or unverified identity. Fix the input (mint a fresh ID-JAG if signature/`jti`/`aud`/`exp`-related). |
| `invalid_claim_token`              | `/agent/register/claim/complete` | `claim_token` wrong or expired. Restart at Step 3.                                                                                                                     |
| `otp_invalid`                      | `/agent/register/claim/complete` | OTP mismatch. Ask the user to re-read the code.                                                                                                                        |
| `otp_expired`                      | `/agent/register/claim/complete` | OTP window passed. Re-trigger the claim email (Step 4a) or restart at Step 3.                                                                                          |
| `claim_expired`                    | `/agent/register/claim/complete` | The whole registration expired. Restart at Step 3.                                                                                                                     |
| `previously_claimed`               | `/agent/register/claim/complete` | Someone already finished this claim. Restart at Step 3 if you need a fresh assertion.                                                                                  |
| `invalid_grant`                    | `/oauth2/token`                  | Assertion expired, revoked, replayed, or otherwise failed verification. Restart at [Step 3](#step-3--register) to mint a fresh one.                                    |
| `invalid_client`                   | `/oauth2/token`                  | `client_id` not recognized. Re-read AS metadata.                                                                                                                       |
| `unsupported_grant_type`           | `/oauth2/token`                  | `grant_type` must be `urn:ietf:params:oauth:grant-type:jwt-bearer`.                                                                                                    |
| `insufficient_user_authentication` | `/oauth2/token`                  | Step-up needed ([RFC 9470](https://datatracker.ietf.org/doc/html/rfc9470)). Restart at [Step 3](#step-3--register) and walk the claim ceremony.                        |
| `rate_limited` (429)               | any                              | Back off and retry.                                                                                                                                                    |

Retry policy:

- 5xx → exponential backoff, retry the same request.
- 4xx → do not retry the same payload; act on the table above.
- 401 on a previously-working access_token → retry [Step 5](#step-5--exchange-the-assertion) once with the current assertion. If that fails, restart at [Step 1](#step-1--discover).

## Revocation

Two independent layers can kill what you're holding:

- **Credential layer ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009), `revocation_endpoint`)** — agent-callable. POST `token=<access_token>&token_type_hint=access_token` (form-encoded) to the top-level `revocation_endpoint` to kill one access_token. 200 on success, idempotent. Your `identity_assertion` is intact; re-run [Step 5](#step-5--exchange-the-assertion) to mint a fresh access_token.
- **Registration layer ([RFC 8935](https://datatracker.ietf.org/doc/html/rfc8935) Security Event Token delivery, `agent_auth.events_endpoint`)** — provider-driven. The provider that minted your ID-JAG can POST a [SET (RFC 8417)](https://datatracker.ietf.org/doc/html/rfc8417) (`Content-Type: application/secevent+jwt`) to this service's `events_endpoint`. The service invalidates the identity assertion and every access_token derived from it. You don't call this; you discover it the next time `/oauth2/token` returns `invalid_grant` — restart at [Step 3](#step-3--register).

On a 401 for a previously-working access_token: try [Step 5](#step-5--exchange-the-assertion) once. If `/oauth2/token` succeeds, the credential was revoked at the RFC 7009 layer and your fresh access_token works. If `/oauth2/token` returns `invalid_grant`, the registration was killed at the RFC 8935 layer — restart at [Step 3](#step-3--register).
