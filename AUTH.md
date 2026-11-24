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
  "grant_types_supported": [
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
    "urn:workos:agent-auth:grant-type:claim"
  ],

  "agent_auth": {
    "skill": "https://service.example.com/auth.md",
    "identity_endpoint": "https://auth.service.example.com/agent/identity",
    "claim_endpoint": "https://auth.service.example.com/agent/identity/claim",
    "events_endpoint": "https://auth.service.example.com/agent/event/notify",
    "identity_types_supported": ["anonymous", "identity_assertion", "service_auth"],
    "identity_assertion": {
      "assertion_types_supported": [
        "urn:ietf:params:oauth:token-type:id-jag"
      ]
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
- `grant_types_supported` — lists the grant types accepted at `/oauth2/token`. `urn:ietf:params:oauth:grant-type:jwt-bearer` ([RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523)) is for exchanging your identity_assertion for an access_token (Step 5). `urn:workos:agent-auth:grant-type:claim` is the polling grant for the claim ceremony (Step 4c) — a profile-specific URN so it doesn't collide with services that also implement standard RFC 8628 device authorization at the same endpoint.
- `agent_auth.skill` — the URL of this document.
- `agent_auth.identity_endpoint` — where you POST to register (Step 3).
- `agent_auth.claim_endpoint` — where you POST the claim invite for anonymous registrations (Step 4) and where the agent polls for ceremony completion at `/view`.
- `agent_auth.events_endpoint` — where the provider POSTs a [Security Event Token (RFC 8417)](https://datatracker.ietf.org/doc/html/rfc8417) per [RFC 8935](https://datatracker.ietf.org/doc/html/rfc8935) push delivery to notify the service of upstream identity events. You don't call this; it tells you what to expect.
- `agent_auth.identity_types_supported` — which registration methods this service accepts. Pick yours from Step 2.
- `agent_auth.identity_assertion.assertion_types_supported` — which assertion types this service accepts under the `identity_assertion` shape (currently ID-JAG).
- `agent_auth.did_key` — present only if `identity_types_supported` includes `did_key`. `challenge_endpoint` is where you fetch a single-use challenge, and `credential_types_supported` lists what registration gives you: `identity_assertion` (the usual Step 5 exchange) and/or `signed_request` (no token at all; you sign every API call with your key). See [did_key](#did_key).
- `agent_auth.events_supported` — event schemas this service can ingest (currently revocation). Informational; you don't act on these directly.

## Step 2 — Pick a method

Use this decision tree:

1. **You have a session tied to a user identity and can exchange it for an ID-JAG, audience-bound to this service** → [identity_assertion + id-jag](#identity_assertion--id-jag).
2. **You have only the user's email** → [service_auth](#service_auth). Claim ceremony required.
3. **You hold an Ed25519 `did:key` and the service lists `did_key` in `identity_types_supported`** → [did_key](#did_key). This proves who you are without a provider or a user. Use it only when the service advertises it: the challenge endpoint is discovery-only.
4. **You have none of these** → [anonymous](#anonymous). Claim ceremony optional; deferred until the user wants to take ownership.

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
  "registration_id": "reg_...",
  "registration_type": "identity_assertion",
  "identity_assertion": "<service-signed JWT>",
  "assertion_expires": "2026-05-04T13:00:00.000Z",
  "scopes": ["api.read", "api.write"]
}
```

Keep `identity_assertion` and go to [Step 5](#step-5--exchange-the-assertion).

**Confirmation required (401)** — `(iss, sub)` is unknown but the ID-JAG's verified email or phone matched an existing account at the service. The service won't silently bind the delegation — the user has to confirm linking the provider identity to their account.

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: AgentAuth error="interaction_required", error_description="…"

{
  "error": "interaction_required",
  "error_description": "…",
  "registration_id": "reg_...",
  "registration_type": "identity_assertion",
  "claim_url": "https://auth.service.example.com/agent/identity/claim",
  "claim_token": "clm_...",
  "claim_token_expires": "…",
  "post_claim_scopes": ["api.read", "api.write"],
  "claim": {
    "user_code": "123456",
    "expires_in": 600,
    "verification_uri": "https://auth.service.example.com/login?return_to=%2Fclaim%3Fclaim_attempt_token%3D...",
    "interval": 5
  }
}
```

Same `claim` block as the `service_auth` registration response — the user signs in to the service, sees a confirmation page that names your provider ("**Acme Provider** is asking to link this account so the agent it runs can act on your behalf"), and types the `user_code` to confirm. Surface `verification_uri` + `user_code` to the user (see [Step 4b](#4b-hand-off-to-the-user)) and poll the token endpoint (see [Step 4c](#4c-poll-for-completion)).

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
  "registration_id": "reg_...",
  "registration_type": "service_auth",
  "claim_url": "https://auth.service.example.com/agent/identity/claim",
  "claim_token": "clm_...",
  "claim_token_expires": "2026-05-21T17:31:25.994Z",
  "post_claim_scopes": ["api.read", "api.write"],
  "claim": {
    "user_code": "123456",
    "expires_in": 600,
    "verification_uri": "https://auth.service.example.com/login?return_to=%2Fclaim%3Fclaim_attempt_token%3D...",
    "interval": 5
  }
}
```

No `identity_assertion` yet — the claim ceremony is bundled into the registration response. Its shape borrows from [RFC 8628 device-authorization](https://datatracker.ietf.org/doc/html/rfc8628) (`user_code`, `verification_uri`, `expires_in`, `interval`) with a `claim_attempt_token` binding parameter embedded in `verification_uri` so the URL identifies the registration without leaking the user-typed `user_code`. The agent surfaces `claim.verification_uri` and `claim.user_code` to the user, and polls the `token_endpoint` from AS metadata with a profile-specific grant until the ceremony completes (see [Step 4](#step-4--claim-ceremony)). `claim_token` is returned exactly once — hold it in memory for the duration of the ceremony; do not persist it past Step 4.

### anonymous

```http
POST /agent/identity
Content-Type: application/json

{ "type": "anonymous" }
```

Response (200):

```json
{
  "registration_id": "reg_...",
  "registration_type": "anonymous",
  "identity_assertion": "<service-signed JWT>",
  "assertion_expires": "2026-05-04T13:00:00.000Z",
  "pre_claim_scopes": ["api.read"],
  "claim_url": "https://auth.service.example.com/agent/identity/claim",
  "claim_token": "clm_...",
  "claim_token_expires": "2026-05-21T17:26:32.915Z",
  "post_claim_scopes": ["api.read", "api.write"]
}
```

The `identity_assertion` exchanges at `/oauth2/token` for an access_token with `pre_claim_scopes` immediately. If you also want a human to take ownership and unlock `post_claim_scopes`, go to [Step 4](#step-4--claim-ceremony). Otherwise skip to [Step 5](#step-5--exchange-the-assertion). `claim_token` is returned exactly once — hold it in memory for the duration of the ceremony; do not persist it past Step 4.

### did_key

For agents whose identity is an Ed25519 key, published as a [`did:key`](https://w3c-ccg.github.io/did-method-key/). The DID already contains the public key, so the service verifies proof of possession locally. There is no provider, no JWKS fetch and no DID resolution.

Discovery, inside `agent_auth`:

```json
"identity_types_supported": ["anonymous", "did_key"],
"did_key": {
  "challenge_endpoint": "https://auth.service.example.com/agent/identity/challenge",
  "credential_types_supported": ["identity_assertion", "signed_request"],
  "request_signing": "https://docs.service.example.com/request-signing"
}
```

**1. Get a challenge.**

```http
POST /agent/identity/challenge
```

```json
{
  "challenge": "<base64url, ≥ 32 random bytes>",
  "expires_at": "2026-05-04T12:01:00.000Z"
}
```

The challenge is single-use and short-lived (60 s recommended, 300 s max).

**2. Sign and register.** Sign this exact UTF-8 string with your Ed25519 key:

```
auth.md did_key v1
<issuer from AS metadata>
<challenge>
```

The issuer line binds the proof to this service. Without it, a malicious service could forward its own challenge from a real service, have you sign it, and register at the real service as you.

```http
POST /agent/identity
Content-Type: application/json

{
  "type": "did_key",
  "did": "did:key:z6Mk...",
  "challenge": "<challenge>",
  "signature": "<base64url Ed25519 signature, 64 bytes>",
  "credential_type": "identity_assertion"
}
```

The service checks four things. The challenge must exist, be unexpired and not yet redeemed; it is invalidated whether or not verification succeeds. The DID must be a `did:key` with the Ed25519 multicodec prefix (`0xed01`). The signature must verify over the string above, using the service's own issuer. `credential_type` must be one the service advertised. Re-registering an active DID returns the same registration, so the DID is a stable identity across sessions. A revoked DID is rejected with `did_key_revoked`; it does not get a new registration.

**Response, `credential_type: "identity_assertion"`:** the same shape as the [anonymous](#anonymous) response, with `"registration_type": "did_key"` and `"did"`. The identity assertion's `sub` is the DID. Exchange it at [Step 5](#step-5--exchange-the-assertion). Claim is optional, exactly as for anonymous. A claim binds the DID to a user account, so later registrations with that DID start at `post_claim_scopes`.

**Response, `credential_type: "signed_request"`:**

```json
{
  "registration_id": "reg_...",
  "registration_type": "did_key",
  "did": "did:key:z6Mk...",
  "credential_type": "signed_request",
  "scopes": ["api.read", "api.write"],
  "request_signing": "https://docs.service.example.com/request-signing"
}
```

No token is issued. Your key is the credential: sign each API call exactly as the `request_signing` document specifies. A service offering `signed_request` MUST publish that document as a complete profile: the signature scheme (for example [RFC 9421 HTTP Message Signatures](https://datatracker.ietf.org/doc/html/rfc9421)), how the request names the signing DID, which request components are covered, and the replay rules (timestamp window, nonce or idempotency key). There is no implicit default; if `request_signing` is missing, do not use `signed_request`. Skip Steps 4–6. A service that already authenticates every request this way can offer it without running an OAuth token endpoint at all; it still publishes the PRM and AS metadata so agents can discover it.

Scopes are always the service's decision. `did_key` proves which key is calling, not what it is allowed to do.

## Step 4 — Claim ceremony

The end goal: get a signed-in user to confirm a 6-digit `user_code` **you supply them**. The code travels from you → user, not from the service → user; the user authenticates to the service and types the code into a page the service owns. This binds the agent's context to the user's authenticated session at the service. The ceremony fields (`user_code`, `verification_uri`, `expires_in`, `interval`) borrow their shape from [RFC 8628 device authorization](https://datatracker.ietf.org/doc/html/rfc8628), and polling happens at the standard `token_endpoint` with a profile-specific grant.

### 4a. Get the ceremony materials

For **service_auth** registrations, you already have them — they're in the `claim` block of the Step 3 response. Skip to 4b.

For **anonymous** registrations, ask the service to start a ceremony:

```http
POST /agent/identity/claim
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
  "claim_attempt_id": "cla_...",
  "status": "initiated",
  "expires_at": "2026-05-21T17:31:25.994Z",
  "claim_attempt": {
    "user_code": "123456",
    "expires_in": 600,
    "verification_uri": "https://auth.service.example.com/login?return_to=%2Fclaim%3Fclaim_attempt_token%3D...",
    "interval": 5
  }
}
```

The `claim_attempt` block here — same shape as the `claim` block in the `service_auth` registration response — borrows from [RFC 8628 device-authorization](https://datatracker.ietf.org/doc/html/rfc8628), with `claim_attempt_token` embedded in `verification_uri` so the URL identifies the registration without leaking the user-typed `user_code`. Surface `verification_uri` + `user_code` to the user; poll the standard `token_endpoint` from AS metadata with the claim grant (see 4c).

The `email` you supply on anonymous `/claim` binds the registration to the human you intend the agent to act on behalf of — only that signed-in user can complete the ceremony. Without this, a third party who intercepted the `user_code` could claim the agent for themselves.

### 4b. Hand off to the user

Surface `verification_uri` and `user_code` to the user in a single message. Suggested copy:

> Open this link, sign in (or sign up), and enter this 6-digit code: **123456**
> https://auth.service.example.com/login?return_to=...

Be explicit that the code goes into the page they land on after signing in — not back to you. The user will:

1. Open `verification_uri`.
2. Authenticate with the service (existing user → sign in; new user → sign up and verify email, depending on the service).
3. Land on the claim page, see "you're signed in as <email>", type the `user_code`, and submit.

### 4c. Poll for completion

Poll the standard `token_endpoint` (from AS metadata) with the profile-specific claim grant, passing your `claim_token`:

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:workos:agent-auth:grant-type:claim
&claim_token=<clm_...>
```

Why a profile-specific grant URN (and not `urn:ietf:params:oauth:grant-type:device_code` directly)? So this surface doesn't collide with a service that also implements standard RFC 8628 device authorization at the same token endpoint — the AS routes by grant_type, no risk of a claim_token being looked up in a device-auth store or vice versa.

Response while waiting (RFC 8628 §3.5 vocabulary):

```json
{ "error": "authorization_pending", "error_description": "..." }
```

Response on success: a standard OAuth token response, plus an `identity_assertion` extension so you have a refresh path via the JWT-bearer grant once this access_token expires.

```json
{
  "access_token": "<post-claim access_token>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "api.read api.write",
  "identity_assertion": "<service-signed JWT>",
  "assertion_expires": "2026-05-21T18:31:25.994Z"
}
```

Use `access_token` immediately on `/api/resource`; cache `identity_assertion` for the eventual refresh.

For **anonymous** flows, completion of the ceremony **revokes** any pre-claim access_tokens you held. Use the post-claim access_token from this response; drop the pre-claim one. The pre-claim `identity_assertion` (v1) also gets superseded by the v2 returned here — the v2 carries the user's email/email_verified claims, the v1 didn't.

If the `user_code` window passes without the user finishing:

```json
{ "error": "expired_token", "error_description": "..." }
```

Two cases distinguish what to do next:

- **Registration is still active** (most common — the user_code's 10-minute timer expired but the outer claim window is still open): call `POST /agent/identity/claim` with the same `claim_token` and the same `email` to mint a fresh `claim_attempt` block. Surface the new `user_code` and `verification_uri` to the user and resume polling. This works for both anonymous and service_auth registrations.
- **Registration itself has expired** (the outer claim window — typically 24h — has closed): start over at Step 3.

If you can't tell which it is from context, try re-initiating first; the claim endpoint returns `410 claim_expired` if the registration is gone, at which point you restart at Step 3.

Honor `interval` (in seconds); on `slow_down` back off. The next poll after `expires_in` will return `expired_token`.

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

Extract `access_token` and go to [Step 6](#step-6--use-the-access_token). The same `identity_assertion` can be re-used to mint additional access_tokens until it expires.

If `/oauth2/token` returns `invalid_grant`, your `identity_assertion` is expired or revoked. Restart the flow at [Step 3](#step-3--register) to mint a fresh identity assertion.

## Step 6 — Use the access_token

Present the `access_token` as a bearer token:

```http
GET /api/some-resource
Authorization: Bearer <access_token>
```

**Refresh.** When the access_token expires (`expires_in` seconds after issuance), re-call [Step 5](#step-5--exchange-the-assertion) with the same `identity_assertion`. When the identity assertion itself expires or `/oauth2/token` returns `invalid_grant`, restart at [Step 3](#step-3--register). There is no OAuth refresh_token in this flow — the two-step pattern replaces it.

If you get a 401 on a previously-working access_token: try [Step 5](#step-5--exchange-the-assertion) once with the current assertion. If that also fails, discard the expired identity assertion, and restart at [Step 1](#step-1--discover).

Full API reference: `https://docs.service.example.com/`.

## Errors

Errors at `/agent/identity` and `/agent/identity/claim/*` use profile-specific codes (the registration ceremonies have no OAuth analog). Errors at `/oauth2/token` use OAuth-standard vocabulary per [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) / [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523).

| Code                         | Where                         | What to do                                                                                                                                                                             |
| ---------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anonymous_not_enabled`      | `/agent/identity`             | This service doesn't accept anonymous. Pick another method from Step 2.                                                                                                                |
| `service_auth_not_enabled`   | `/agent/identity`             | service_auth (email-based) disabled here. Pick another method.                                                                                                                         |
| `did_key_not_enabled`        | `/agent/identity`             | This service doesn't accept did_key, or not with the requested `credential_type`. Pick another method or credential type.                                                              |
| `did_key_revoked`            | `/agent/identity` (did_key)   | This DID's registration was revoked. Don't retry with the same key; register a new DID if the service allows it.                                                                      |
| `invalid_challenge`          | `/agent/identity` (did_key)   | Challenge unknown, expired or already used. Fetch a new one from `challenge_endpoint` and sign again.                                                                                  |
| `issuer_not_enabled`         | `/agent/identity`             | Provider not on this service's trust list. Pick another method.                                                                                                                        |
| `invalid_request`            | `/agent/identity`             | Body shape, missing claims, ID-JAG signature/`jti`/`aud` problems, or unverified identity. Fix the input (mint a fresh ID-JAG if signature/`jti`/`aud`/`exp`-related).                 |
| `interaction_required` (401) | `/agent/identity` (ID-JAG)    | Step-up: ID-JAG matched an existing account but no `(iss, sub)` delegation yet. Body carries a `claim` block; surface it to the user (see [Step 4](#step-4--claim-ceremony)).          |
| `login_required` (401)       | `/agent/identity` (ID-JAG)    | `auth_time` missing or older than `max_age`. Re-authenticate the user at your provider (`prompt=login` or equivalent) and mint a fresh ID-JAG. The service can't help here.            |
| `invalid_claim_token`        | `/agent/identity/claim`       | `claim_token` wrong or expired. Restart at Step 3.                                                                                                                                     |
| `claimed_or_in_flight`       | `/agent/identity/claim`       | Wrong endpoint for this registration kind, or already claimed. Re-read the Step 3 response and follow Step 4.                                                                          |
| `claim_expired`              | `/agent/identity/claim`       | The registration expired before the user finished. Restart at Step 3.                                                                                                                  |
| `invalid_grant`              | `/oauth2/token`               | Assertion expired, revoked, replayed, or otherwise failed verification. Restart at [Step 3](#step-3--register) to mint a fresh one.                                                    |
| `invalid_client`             | `/oauth2/token`               | `client_id` not recognized. Re-read AS metadata.                                                                                                                                       |
| `unsupported_grant_type`     | `/oauth2/token`               | `grant_type` is not one of the two supported values (`urn:ietf:params:oauth:grant-type:jwt-bearer` for token exchange, `urn:workos:agent-auth:grant-type:claim` for ceremony polling). |
| `authorization_pending`      | `/oauth2/token` (claim grant) | User hasn't completed the ceremony yet. Honor `interval` from the `claim` or `claim_attempt` block; retry.                                                                             |
| `expired_token`              | `/oauth2/token` (claim grant) | `user_code` window or outer claim window has closed. Re-call `/agent/identity/claim` to mint a fresh user_code; if that returns `claim_expired`, restart at Step 3.                    |
| `slow_down`                  | `/oauth2/token` (claim grant) | Polling too fast. Add at least 5s to your `interval` and retry.                                                                                                                        |
| `rate_limited` (429)         | any                           | Back off and retry.                                                                                                                                                                    |

`user_code` errors are surfaced to the user on the claim page — they never reach you. Your poll keeps returning `"status": "pending"` until either the user gets the code right or the window expires (`"status": "expired"`).

Retry policy:

- 5xx → exponential backoff, retry the same request.
- 4xx → do not retry the same payload; act on the table above.
- 401 on a previously-working access_token → retry [Step 5](#step-5--exchange-the-assertion) once with the current assertion. If that fails, restart at [Step 1](#step-1--discover).

## Revocation

Two independent layers can kill what you're holding:

- **Credential layer ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009), `revocation_endpoint`)** — agent-callable. POST `token=<access_token>&token_type_hint=access_token` (form-encoded) to the top-level `revocation_endpoint` to kill one access_token. 200 on success, idempotent. Your `identity_assertion` is intact; re-run [Step 5](#step-5--exchange-the-assertion) to mint a fresh access_token.
- **Registration layer ([RFC 8935](https://datatracker.ietf.org/doc/html/rfc8935) Security Event Token delivery, `agent_auth.events_endpoint`)** — provider-driven. The provider that minted your ID-JAG can POST a [SET (RFC 8417)](https://datatracker.ietf.org/doc/html/rfc8417) (`Content-Type: application/secevent+jwt`) to this service's `events_endpoint`. The service invalidates the identity assertion and every access_token derived from it. You don't call this; you discover it the next time `/oauth2/token` returns `invalid_grant` — restart at [Step 3](#step-3--register).

- **did_key registrations** — the service can revoke a DID's registration at any time. Revocation is permanent for that DID and also invalidates its identity assertion and every access_token derived from it. You find out at Step 5 (`invalid_grant`) or, for `signed_request`, from a 401 on a signed call; re-registering then returns `did_key_revoked`. If your key may be compromised, stop using it and register a new DID; a DID cannot be rotated.

On a 401 for a previously-working access_token: try [Step 5](#step-5--exchange-the-assertion) once. If `/oauth2/token` succeeds, the credential was revoked at the credential layer and your fresh access_token works. If `/oauth2/token` returns `invalid_grant`, the registration was killed at the registration layer — restart at [Step 3](#step-3--register).
