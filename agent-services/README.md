# Agent Auth Consumer Guide

Services that want agents to authenticate on behalf of users — via Identity Assertion JWT Authorization Grants ([ID-JAGs](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-identity-assertion-authz-grant)) from trusted providers, via a verified-email claim ceremony, or via anonymous self-registration when no user identity is available — need to publish discovery metadata and implement the `/agent/identity` registration endpoint and standard OAuth `/oauth2/token` and `/oauth2/revoke` endpoints described here.

This guide covers three flows:

1. **ID-JAG identity assertion** — trusted agent providers (OpenAI, Anthropic, Cursor, etc.) assert a user's identity with an ID-JAG. The service verifies the assertion and returns a service-signed identity assertion the agent exchanges at the token endpoint for an access_token.
2. **service_auth (email-based claim)** — the agent gives us a user email as a `login_hint`; the service hands the agent a `verification_uri` (no code), the agent hands it to the user, the user signs in on a service page and confirms, and the page reveals a 6-digit `user_code` the user reads back to the agent. The agent submits that code to finish.
3. **Anonymous registration** — an agent with no user identity self-registers for a pre-claim identity assertion and optionally invites a human to take ownership later via the same claim ceremony.

All three flows share the same `/agent/identity` registration endpoint and terminate at `/oauth2/token` (RFC 7523 JWT-bearer) for credential issuance. service_auth and anonymous flows additionally use the claim ceremony, whose ceremony fields borrow their shape from [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) device authorization — but the `user_code` travels service → user → agent (revealed on the service's page, read back to the agent), and the agent completes at `/agent/identity/claim/complete` rather than polling.

**Why adopt this.** ID-JAG is a near-drop-in if your service already JIT-provisions users via OIDC or SAML — it's standard JWT verification against a provider JWKS plus a delegation record per `(iss, sub, aud)`, with no user-model changes. The claim flows are a real extension (a pre-claim principal state, a claim state machine, a scope-set swap) but they unlock MCP-server agents that start with no user identity — a use case nothing else handles cleanly. All three flows give users a real revoke surface for agent delegations, instead of copy-pasted API keys the service has no visibility into.

## Sequence Diagrams

### Identity Assertion

```mermaid
sequenceDiagram
    actor User
    participant Agent
    participant Provider as Agent Provider
    participant Service

    Agent->>Service: GET /api/resource
    Service-->>Agent: 401 Unauthorized<br/>WWW-Authenticate: Bearer resource_metadata="..."

    Agent->>Service: GET /.well-known/oauth-protected-resource
    Service-->>Agent: 200 OK (PRM with authorization_servers)
    Agent->>Service: GET /.well-known/oauth-authorization-server
    Service-->>Agent: 200 OK (AS metadata with agent_auth block)

    Agent->>User: Consent to assert identity to audience?
    User-->>Agent: Consent granted

    Agent->>Provider: Request audience-specific ID-JAG
    Provider-->>Agent: 200 OK (ID-JAG)

    Agent->>Service: POST /agent/identity<br/>{ type: identity_assertion, assertion: ID-JAG }
    Service->>Provider: GET /.well-known/jwks.json
    Provider-->>Service: 200 OK (JSON Web Key Set)
    Service->>Service: Verify signature + claims, match user
    Service-->>Agent: 200 OK (identity.assertion)

    Agent->>Service: POST /oauth2/token<br/>grant_type=jwt-bearer&assertion=...
    Service-->>Agent: 200 OK (access_token)
```

### Anonymous Registration + Claim Ceremony

```mermaid
sequenceDiagram
    actor User
    participant Agent
    participant Service

    Agent->>Service: POST /agent/identity<br/>{ type: anonymous }
    Service-->>Agent: 200 OK (identity.assertion, claim.token)
    Agent->>Service: POST /oauth2/token<br/>grant_type=jwt-bearer&assertion=...
    Service-->>Agent: 200 OK (access_token, pre-claim scope)

    Note over Agent: Agent operates with pre-claim scopes

    User-->>Agent: Wants to take ownership
    Agent->>Service: POST /agent/identity/claim<br/>{ type: service_auth, claim_token, login_hint }
    Service-->>Agent: 200 OK (attempt.verification_uri)
    Agent-->>User: Surface verification_uri (no code)
    User->>Service: GET verification_uri (signs in, lands on /claim)
    User->>Service: POST /claim/confirm (confirms)
    Service-->>User: Reveals user_code on the page
    User-->>Agent: Reads user_code back
    Agent->>Service: POST /agent/identity/claim/complete<br/>{ claim_token, user_code }
    Service-->>Agent: 200 OK (post-claim identity.assertion + refresh_token)
```

### Service Auth (Email-Based Claim)

```mermaid
sequenceDiagram
    actor User
    participant Agent
    participant Service

    Agent->>Service: POST /agent/identity<br/>{ type: service_auth, login_hint: email }
    Service-->>Agent: 200 OK (claim.token, claim.attempt.verification_uri)
    Agent-->>User: Surface verification_uri (no code)
    User->>Service: GET verification_uri (signs in as asserted email, lands on /claim)
    User->>Service: POST /claim/confirm (confirms)
    Service-->>User: Reveals user_code on the page
    User-->>Agent: Reads user_code back
    Agent->>Service: POST /agent/identity/claim/complete<br/>{ claim_token, user_code }
    Service-->>Agent: 200 OK (identity.assertion + refresh_token)
```

## Minimum Consumer Implementation

To participate as a consumer service, you should:

1. Publish `.well-known/oauth-protected-resource` (resource + `authorization_servers`) and `.well-known/oauth-authorization-server` (top-level OAuth endpoints + `agent_auth` block)
2. Return `WWW-Authenticate: Bearer resource_metadata="..."` on 401 responses
3. Host `/agent/identity` (and its `/claim` sub-endpoints) that dispatches on `type` and returns a service-signed `identity_assertion`
4. Host `/oauth2/token` (RFC 7523 JWT-bearer) that exchanges the `identity_assertion` for an access_token
5. Host `/oauth2/revoke` (RFC 7009) for agent-initiated credential revocation
6. Accept provider-initiated Security Event Tokens (RFC 8417) at the advertised `events_endpoint`
7. Maintain a trust list of agent providers (for `identity_assertion`)
8. Verify ID-JAG signatures against the provider's JWKS and enforce claim checks
9. Record audit events for every state change in the flow

### Publishing the Discovery Documents

Discovery is split in two:

1. The Protected Resource Metadata at `/.well-known/oauth-protected-resource` (per [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)) advertises the resource and points at the Authorization Server.
2. The Authorization Server metadata at `/.well-known/oauth-authorization-server` carries the `agent_auth` block describing supported flows.

PRM:

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

AS metadata:

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

Top-level `issuer` / `token_endpoint` / `revocation_endpoint` / `grant_types_supported` follow [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) (with `revocation_endpoint` per [RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)). The `agent_auth` block is a profile extension for the agent-auth–specific surface: the registration endpoint, the claim ceremony, and the [RFC 8935](https://datatracker.ietf.org/doc/html/rfc8935) SET receiver.

Advertise the identity types and assertion types your service accepts. Anonymous is the simplest if you only support self-registration; ID-JAG is for trusted-provider integrations; service_auth is for agents that have a user email but no provider-signed assertion. The claim ceremony is not a `/oauth2/token` grant, so `grant_types_supported` lists only the JWT-bearer exchange.

On any 401 from your API, include the discovery hint:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://api.service.example.com/.well-known/oauth-protected-resource"
```

Consider also publishing an `auth.md` at your root — a short, LLM-readable summary of your agent auth posture that points back at the PRM, for agents that discover via documentation rather than 401 probing.

### Hosting the /agent/identity Endpoint

The endpoint dispatches on the `type` field. All requests scope to a single tenant / environment; how the service resolves that scope (hostname, bearer token, path prefix) is up to the implementation. Every path through this endpoint returns a service-signed `identity_assertion` (a JWT with `typ: oauth-id-jag+jwt` and `sub = registration.id`) — never a credential. The agent exchanges that assertion at [`/oauth2/token`](#post-oauth2token--rfc-7523-jwt-bearer-grant) to obtain an access_token.

```http
POST /agent/identity HTTP/1.1
Host: auth.service.example.com
Content-Type: application/json
```

#### type: identity_assertion

Request:

```json
{
  "type": "identity_assertion",
  "assertion_type": "urn:ietf:params:oauth:token-type:id-jag",
  "assertion": "eyJhbGc..."
}
```

Implementation steps:

1. **Decode the ID-JAG header** to obtain `kid` and `alg`.
2. **Look up the issuer (`iss`)** in your trusted providers list. Reject if unknown.
3. **Fetch JWKS** from the provider (see [Verifying ID-JAGs](#verifying-id-jags) for caching).
4. **Verify the signature** using the key matching `kid`.
5. **Validate claims:** `aud` matches your auth server; `exp` is future; `iat` is not unreasonably future; `jti` has not been seen recently; `client_id` resolves to a known provider identity; at least one of `email_verified` or `phone_number_verified` is `true`; **`auth_time` is present and within `idJagMaxAuthAgeSeconds`** (see [auth_time freshness](#auth_time-freshness) below).
6. **Match or provision the user** (see [User Matching and JIT Provisioning](#user-matching-and-jit-provisioning)). If the match resolves to an existing user via email/phone but no `(iss, sub)` delegation exists yet, step up (see [First-link step-up](#first-link-step-up) below) — do **not** silently bind.
7. **Mint a service-signed identity assertion** (typed `oauth-id-jag+jwt`, signed by your AS key, with `sub` = the registration ID). This is what the agent will exchange at `/oauth2/token`.

Clean-match response:

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

The agent then POSTs `identity.assertion` to [`/oauth2/token`](#post-oauth2token) to obtain an access_token. No credential is issued at `/agent/identity` itself.

Error response (400 except where noted):

```json
{ "error": "invalid_audience", "message": "..." }
```

Supported error codes: `invalid_issuer`, `invalid_signature`, `expired`, `replay_detected`, `invalid_audience`, `invalid_client_id`, `missing_verified_email`, `auth_time_missing` and `auth_time_too_old` (mapped to **401 `login_required`** for the agent; see below), `interaction_required` (**401**, step-up required; see below).

##### auth_time freshness

Reject ID-JAGs whose `auth_time` is missing or older than your configured `idJagMaxAuthAgeSeconds` (default 1h) with HTTP 401 and:

```http
WWW-Authenticate: AgentAuth error="login_required", max_age="3600", error_description="..."
```

```json
{ "error": "login_required", "error_description": "...", "max_age": 3600 }
```

The agent's recourse is to refresh the user's authentication at _its provider_ (`prompt=login` or equivalent) and mint a fresh ID-JAG. Nothing the user does at your service helps — that's why this is distinct from step-up. Apply the freshness check universally (even on `(iss, sub)` pairs you already have a delegation for) to prevent indefinite session piggy-backing.

##### First-link step-up

When the matcher finds an existing user by verified email/phone but no `(iss, sub)` delegation yet, do not silently bind the delegation. Return HTTP 401 with a `claim` block — the user has to confirm linking the provider identity to their account:

```http
WWW-Authenticate: AgentAuth error="interaction_required", error_description="..."
```

```json
{
  "error": "interaction_required",
  "error_description": "...",
  "id": "reg_...",
  "type": "identity_assertion",
  "scopes": { "post_claim": ["api.read", "api.write"] },
  "claim": {
    "token": "clm_...",
    "expires_at": "...",
    "url": "/agent/identity/claim",
    "attempt": {
      "verification_uri": "...",
      "expires_at": "..."
    }
  }
}
```

The `claim` block is the same shape as the service_auth and anonymous flows ([Claim Ceremony](#claim-ceremony)). The user-facing `/claim` page renders provider-aware copy for ID-JAG registrations ("**Acme** is asking to link this account…") — the provider display name comes from your trust list. After the user confirms and reads the `user_code` back, the agent submits it at `/agent/identity/claim/complete` to bind the delegation. The same `(iss, sub, aud)` triple is keyed on a single registration row whether pending or bound, so repeat presentations during step-up reuse the row and re-issue a fresh ceremony.

**Why step up.** Without it, any trusted provider could mint an ID-JAG with `email_verified: true` for `victim@example.com` and silently take over that user's account at your service. Step-up gates the binding on the user being signed in at your service — their authenticated session is what authorizes the link.

In production, services often source provider display names from CIMD ([Client ID Metadata Document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)) instead of maintaining them by hand — the provider hosts a metadata document at a stable URL and the service fetches it. Either way, the service decides what `/claim` renders; never render a `client_name` value the provider sets directly, since a malicious provider would pick its own marketing copy.

**The claim ceremony is your primary place to enforce authorization policies.** The agent never authenticates the user; the agent presents an ID-JAG (which the provider authenticated, on the provider's terms) and the service authenticates the user via its existing `/login` flow during the ceremony. Whatever conditions you normally enforce in interactive browser sign-in — enterprise SSO, MFA, bot detection, terms re-acceptance, just-in-time provisioning checks — apply here, with no agent-auth-specific exceptions. If `acme.com` is enterprise-SSO-managed in your tenant, an ID-JAG asserting `alice@acme.com` from a provider Acme should land the user on a sign-in surface that refuses to complete until Alice authenticates through Acme's IdP. The agent waits for the user to finish and read back the code; from the agent's perspective the flow is identical whether the gate is "no gate," "MFA," or "full enterprise SSO." This is how ID-JAGs don't bypass your domain-bound policies.

#### type: anonymous

Request:

```json
{ "type": "anonymous" }
```

Implementation steps:

1. Apply rate limits (see [Rate Limiting](#rate-limiting)).
2. Create the registration. The principal it eventually binds to is up to the service — it might be a user, workspace, account, tenant, or organization. Flag it as agent-created so downstream events and UI can distinguish it.
3. Generate a claim token (prefixed, high-entropy — e.g., `clm_` + 25 chars base62). Store only its SHA-256 hash. Return the plaintext exactly once.
4. Mint a service-signed identity assertion bound to the registration. At `/oauth2/token` exchange time, unclaimed anonymous registrations get the pre-claim scope set.
5. Schedule an expiration job at the registration's TTL to mark the claim expired.

Successful response:

```json
{
  "id": "reg_01ABC123DEF456GHI789JKL0MN",
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
    "token": "clm_abc123def456ghi789jkl012mno",
    "expires_at": "2026-04-22T12:34:56.789Z",
    "url": "/agent/identity/claim"
  }
}
```

See [Claim Ceremony](#claim-ceremony) for the `/agent/identity/claim` init and the agent's completion call. After a successful claim the agent re-exchanges the post-claim `identity.assertion` at `/oauth2/token` to pick up the `scopes.post_claim` set. (Anonymous registrations get no pre-minted attempt — the agent starts one at `/agent/identity/claim`.)

#### type: service_auth

Request:

```json
{
  "type": "service_auth",
  "login_hint": "user@example.com"
}
```

Implementation steps:

1. Create a registration row marked as `service_auth` and persist the asserted email as `claim_email`.
2. Generate a `claim_token` (returned to the agent), a `claim_attempt_token` (embedded in `verification_uri`), and a 6-digit `user_code`. Store SHA-256 hashes of the tokens; keep the `user_code` to reveal on the claim page later. Return the plaintext `claim_token` and embed the `claim_attempt_token` in the `verification_uri`. **The `user_code` is never returned to the agent.**
3. Return the claim handles + a `claim` block with the first `attempt` (see [Claim Ceremony](#claim-ceremony)) — but **no identity assertion**. The assertion is minted when the agent completes the ceremony at `/agent/identity/claim/complete`.

Successful response:

```json
{
  "id": "reg_01ABC...",
  "type": "service_auth",
  "scopes": { "post_claim": ["api.read", "api.write"] },
  "claim": {
    "token": "clm_abc123...",
    "expires_at": "2026-04-22T12:34:56.789Z",
    "url": "/agent/identity/claim",
    "attempt": {
      /* verification_uri, expires_at — no user_code */
    }
  }
}
```

### POST /oauth2/token

The token endpoint handles a single grant, `urn:ietf:params:oauth:grant-type:jwt-bearer` — the agent presents a service-signed identity assertion in exchange for an access_token. The claim ceremony does **not** run through this endpoint; the agent completes it at [`/agent/identity/claim/complete`](#post-agentidentityclaimcomplete--agent-completion) and gets a refresh token for the assertion-refresh path.

#### JWT-bearer grant (RFC 7523)

The agent presents the service-signed identity assertion to exchange it for an access_token. Standard [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523) JWT-bearer grant, form-encoded:

```
POST /oauth2/token HTTP/1.1
Host: auth.service.example.com
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
&assertion=<identity_assertion>
&resource=https://api.service.example.com/
```

Implementation steps:

1. **Parse the form-encoded body.** Validate `grant_type`; route to this handler. Any other value returns `unsupported_grant_type`.
2. **Verify the `assertion`** against your service's signing key. It must be `typ: "oauth-id-jag+jwt"`, with `iss` and `aud` equal to your AS, a valid `exp`, and a `sub` resolving to a registration in your store.
3. **Look up the registration by `sub`.** If absent or expired, return `invalid_grant`.
4. **Issue an access_token** scoped per the registration's state. Anonymous-unclaimed gets your configured pre-claim scopes; everything else gets the registration's full granted set.

Successful response (standard OAuth shape per RFC 6749 §5.1):

```json
{
  "access_token": "<token>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "api.read api.write"
}
```

The token endpoint should never issue a `refresh_token`. The same `identity.assertion` can be re-exchanged at `/oauth2/token` to refresh the access_token until the assertion itself expires; when the assertion expires, service_auth and claimed registrations mint a fresh one via [`/agent/identity` `type: refresh`](#assertion-refresh) (anonymous-pre-claim and id_jag re-register).

Error response uses standard OAuth error codes (RFC 6749 §5.2):

```json
{ "error": "invalid_grant", "error_description": "..." }
```

Supported error codes: `invalid_request`, `invalid_grant`, `unsupported_grant_type`.

### POST /oauth2/revoke — RFC 7009 token revocation

The agent (or an admin via back-channel) POSTs the access_token to revoke:

```
POST /oauth2/revoke HTTP/1.1
Host: auth.service.example.com
Content-Type: application/x-www-form-urlencoded

token=<access_token>&token_type_hint=access_token
```

Implementation:

- Mark the credential revoked. 200 OK on success, no body. Idempotent.
- Return 200 even when the token is unknown or already revoked ([RFC 7009 §2.2](https://datatracker.ietf.org/doc/html/rfc7009#section-2.2) — prevents enumeration).
- Return 400 with `{ "error": "invalid_request", "error_description": "..." }` only when the body itself is malformed.

The agent's `identity_assertion` is unaffected — they can immediately re-call `/oauth2/token` to mint a fresh access_token. To kill the underlying registration, the provider POSTs a SET to the `events_endpoint` (see [Revocation](#revocation)).

### Verifying ID-JAGs

A compliant ID-JAG header is `{ "typ": "oauth-id-jag+jwt", "alg", "kid" }`. The body includes `iss`, `sub`, `aud`, `client_id`, `jti`, `iat`, `exp`, and identity claims like `email` / `email_verified`. See the provider guide for the full shape.

**Trust list.** Maintain a registry of providers whose assertions you accept. A minimum entry is an issuer URL; richer entries include a service-controlled `display_name` (rendered on the step-up confirmation page so the user sees "**Acme** is asking to link…"), a pinned JWKS URI, a CIMD URL, or an attestation policy (e.g. "requires `mfa` in `amr`"). Treat this list as security-critical configuration — compromising a trusted provider means compromising every delegation routed through them. Don't pull the display name straight from the ID-JAG or unmediated CIMD; a malicious provider would set its own copy. The service decides what shows on its own UI.

**JWKS fetching.** Fetch `{iss}/.well-known/jwks.json` on first use and cache per the response's `Cache-Control`, with a sane floor (e.g., 10 minutes) and ceiling (e.g., 24 hours). On `kid` cache miss, refetch once before rejecting — this handles provider key rotation gracefully.

**CIMD resolution.** If `client_id` is a URL rather than an opaque identifier, fetch it as an [OAuth Client ID Metadata Document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/) and verify its `jwks_uri` matches the one you used to verify the signature. This decouples the provider's identity from their signing keys so rotation doesn't churn your trust list.

**Replay protection.** Keep a cache of seen `jti` values with a TTL of at least `exp - iat` plus clock skew (a 5-minute assertion + 1 minute of skew → 6 minutes of cache). Redis, Memcached, or an indexed database table with a TTL column all work. Reject on collision with `replay_detected`.

**Clock skew.** Accept `iat` up to ~1–2 minutes in the future to accommodate drift between provider and consumer clocks.

### User Matching and JIT Provisioning

When an ID-JAG arrives, decide which of your users it represents. Recommended resolution order:

1. **Delegation record match.** If you've previously issued credentials for this `(iss, sub)`, route to the same user. This is the strongest identifier — it's what the provider considers stable. Clean match.
2. **Verified email/phone match → step-up.** If a user exists with the same verified email or phone but no `(iss, sub)` delegation, _don't bind silently_. Trigger the [first-link step-up ceremony](#first-link-step-up) — the user must confirm linking the provider identity to their account. Without this gate, any trusted provider could mint an ID-JAG asserting a victim's email and take over the victim's account.
3. **No match → JIT.** Create a new user per your provisioning policy, or refuse if your product requires manual onboarding. Clean match.

Reject ID-JAGs with neither a verified email nor a verified phone — there's no basis for matching.

### Claim Ceremony

Both `anonymous` and `service_auth` flows funnel into the same ceremony, and it's always the **service_auth** method (anonymous registrations are claimed via service_auth too): the agent hands the user a `verification_uri` (no code), the user signs in to the service and confirms on a service-owned page, the page **reveals** a `user_code`, the user reads it back to the agent, and the agent submits it at `/agent/identity/claim/complete`. The ceremony fields (`user_code`, `verification_uri`) borrow their shape from [RFC 8628 device authorization](https://datatracker.ietf.org/doc/html/rfc8628), but the code travels service → user → agent, so there is no polling grant and no `interval`.

| Flow         | First attempt minted at                           | claim/complete returns                                                                                 |
| ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Anonymous    | `/agent/identity/claim` (agent starts it)         | Post-claim identity: a **v2** `identity.assertion` (the v1 was pre-claim) + a rotating `refresh_token` |
| service_auth | `/agent/identity` (bundled under `claim.attempt`) | The first `identity.assertion` (none was issued at registration time) + a rotating `refresh_token`     |

#### Attempt block shape

Returned nested under `claim.attempt` (service_auth registration response) or `attempt` (the `/agent/identity/claim` response):

```json
{
  "verification_uri": "https://auth.service.example.com/login?return_to=%2Fclaim%3Fclaim_attempt_token%3D...",
  "expires_at": "2026-05-04T12:10:00.000Z"
}
```

The `verification_uri` routes through `/login` first so the user authenticates before landing on the claim page. `claim_attempt_token` (in the return_to path) binds the URL to a specific registration — opening it identifies the registration without carrying the `user_code`, which the service reveals only after the user confirms. **The `user_code` is never in this block.**

#### POST /agent/identity/claim — Start (or re-mint) an attempt

For **anonymous**, the agent calls this to start the first attempt. For **service_auth**, the first attempt is bundled into the registration response; the agent calls this only to re-mint after a `user_code` expires. Either way, `type` is `service_auth` — the claim method.

Request:

```json
{
  "type": "service_auth",
  "claim_token": "clm_abc123...",
  "login_hint": "user@example.com"
}
```

The `login_hint` binds the attempt to the human the agent is acting for. Only that signed-in user can complete the ceremony — without this binding, a third party who intercepts the link could claim the agent on their own account.

Response (200):

```json
{
  "id": "reg_01ABC...",
  "type": "service_auth",
  "attempt": {
    /* verification_uri, expires_at — see above */
  }
}
```

Implementation notes:

- Hash the incoming `claim_token` and look up the registration. Reject if not found (`invalid_claim_token`), already claimed (`already_claimed`), or expired (`claim_expired`).
- Record the `login_hint` on the attempt so the claim page can enforce the binding.
- Mint a `claim_attempt_token` and a `user_code`; store the token hash and hold the `user_code` to reveal on the claim page. Return only the `verification_uri` (with the token embedded).
- The `verification_uri` should route through your sign-in flow first (so the user authenticates before the claim page can identify them).

#### User-facing claim page

The user opens `verification_uri`, signs in to the service, and lands on a page that:

1. Resolves the registration via `claim_attempt_token` (from the URL).
2. Verifies the signed-in user matches the attempt's `login_hint` if set — rejects mismatches (`wrong_account`).
3. Renders a **confirm** button (no code input). On confirm, the service binds the confirming user to the attempt and **reveals the `user_code`** for the user to read back to the agent.

This is a service-owned UX surface — agents never see it. The confirm POST is a service-internal form action (`/claim/confirm` in the sample), distinct from the agent-facing `/agent/identity/claim/complete`.

#### POST /agent/identity/claim/complete — Agent completion

The agent submits its `claim_token` plus the `user_code` the user read back:

```
POST /agent/identity/claim/complete HTTP/1.1
Host: auth.service.example.com
Content-Type: application/json

{ "claim_token": "clm_...", "user_code": "123456" }
```

On success — a one-shot response carrying the post-claim identity (the assertion and a rotating refresh token):

```json
{
  "id": "reg_01ABC...",
  "status": "claimed",
  "identity": {
    "assertion": "<service-signed JWT>",
    "expires_at": "2026-05-04T13:00:00.000Z",
    "refresh_token": {
      "value": "art_...",
      "expires_at": "2026-06-03T12:00:00.000Z"
    }
  }
}
```

Implementation notes:

- Look up the registration by `sha256(claim_token)`. If absent → `invalid_claim`.
- If the attempt hasn't been confirmed by a signed-in user yet → `claim_not_confirmed` (409). The agent waits and retries.
- If the submitted `user_code` doesn't match → `invalid_user_code` (401). If the code's window has closed → `user_code_expired` (410); the agent re-mints via `/agent/identity/claim`. If already claimed → `already_claimed` (409); if the outer window closed → `claim_expired` (410).
- On success, bind the registration to the confirming user, mint the identity assertion (with the user's `email` / `email_verified`) and a rotating `refresh_token`, and return them once.
- For **anonymous**, revoke the pre-claim access_tokens (from earlier jwt-bearer exchanges) — the canonical credential is minted by re-exchanging the post-claim assertion. The v2 assertion carries the now-known `email` claims; the v1 didn't.
- Emit `claim.confirmed` (see [Recommended Audit Events](#recommended-audit-events)).

#### Assertion refresh

service_auth and claimed registrations hold a rotating `refresh_token` (returned by claim/complete). When the assertion nears expiry, the agent exchanges it for a fresh one at `/agent/identity`:

```json
{ "type": "refresh", "refresh_token": "art_..." }
```

The response is a registration envelope with a fresh `identity.assertion` and a new `refresh_token` (the presented one is spent). Reject a missing, expired, or already-spent token with `invalid_refresh_token`. Anonymous pre-claim and id_jag registrations have no refresh token — they re-exchange the still-valid assertion, or re-register.

### Revocation

Revocation has two distinct surfaces:

1. **Agent or admin invalidating a specific credential** — RFC 7009 token revocation at the top-level `revocation_endpoint` (covered in [POST /oauth2/revoke](#post-oauth2revoke--rfc-7009-token-revocation)).
2. **Provider notifying the service of an upstream identity event** — RFC 8935 push-based delivery of a [Security Event Token](https://datatracker.ietf.org/doc/html/rfc8417) to the `agent_auth.events_endpoint`.

#### POST /agent/event/notify — RFC 8935 SET receiver

Providers transmit a signed Security Event Token to deliver identity events (logout, unlink, etc.). The SET's `events` claim names one or more schema URIs identifying the event types in this envelope:

```
POST /agent/event/notify HTTP/1.1
Host: auth.service.example.com
Content-Type: application/secevent+jwt

{ "typ": "secevent+jwt", "alg", "kid" }
.
{
  "iss": "https://api.agent-provider.example.com",
  "sub": "<opaque user identifier>",
  "aud": "https://auth.service.example.com",
  "jti": "<unique identifier>",
  "iat": <epoch seconds>,
  "events": {
    "https://schemas.workos.com/events/agent/auth/identity/assertion/revoked": {}
  }
}
```

On receipt:

1. Verify the SET signature against the issuer's JWKS (same trust path as ID-JAG verification).
2. Validate `iss` against the trust list, `aud` against your service, and enforce `jti` uniqueness for replay protection.
3. Dispatch on each entry in the `events` claim — for the `identity-assertion-revoked` schema, find all credentials issued for `(iss, sub, aud)` and invalidate them. Unknown event schemas can be safely ignored ([RFC 8417 §2.2](https://datatracker.ietf.org/doc/html/rfc8417#section-2.2)).
4. Return 202 Accepted on success, with no body.
5. On failure, return 400 with `{ "err": "<code>", "description": "..." }` per [RFC 8935 §2.4](https://datatracker.ietf.org/doc/html/rfc8935#section-2.4). Defined error codes: `invalid_request`, `invalid_key`, `invalid_issuer`, `invalid_audience`, `authentication_failed`.

The same endpoint can accept additional event types in the future (account suspended, claims updated, etc.) by adding entries to your dispatch table — providers don't need to coordinate; the `events_supported` array in your discovery doc advertises which schemas you're prepared to handle.

A future evolution of this surface is the OpenID [Shared Signals Framework](https://openid.net/specs/openid-sharedsignals-framework-1_0.html) — a stream-management protocol on top of RFC 8935 with subject subscriptions and polling. Today we accept push-only and don't expose stream management.

### Rate Limiting

The `/agent/identity` endpoint is unauthenticated for anonymous registration and accepts bearer ID-JAGs for identity assertion. Both paths benefit from two-tier rate limiting, checked in order:

1. **Per-IP limit** (checked first). Prevents a single source from consuming the tenant's budget. Sensible default: 5/hour for anonymous, 60/hour for identity_assertion.
2. **Per-tenant limit** (checked second). Global cap across IPs. Sensible default: 100/hour anonymous, 1000/hour identity_assertion.

Use a sliding-window counter backed by a shared store (Redis is common). Fail open on store errors to avoid blocking legitimate traffic. If no IP is available (e.g., stripped by a proxy), skip the per-IP check rather than rejecting.

### Recommended Audit Events

Record the following state transitions for observability and incident response. How they're exposed — audit log, webhook, SIEM stream, admin API — is an implementation choice; the set of events and the data they carry is the useful baseline.

| Event                  | When                                                         | Recommended fields                        |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| `registration.created` | Any successful `/agent/identity` POST                        | `registration_id`, `type`                 |
| `assertion.issued`     | A service-signed identity assertion is minted                | `registration_id`                         |
| `token.issued`         | `/oauth2/token` returns an access_token                      | `registration_id`, `scope`                |
| `token.revoked`        | `/oauth2/revoke` invalidates a credential                    | `registration_id`                         |
| `claim.requested`      | `/agent/identity/claim` called (or implicit on service_auth) | `registration_id`, `login_hint`           |
| `user_code.revealed`   | user_code revealed to the confirming user on the claim page  | `registration_id`, `confirmed_by_user_id` |
| `claim.confirmed`      | `/agent/identity/claim/complete` succeeds                    | `registration_id`, `claimed_by_user_id`   |
| `assertion.refreshed`  | `/agent/identity` (`type: refresh`) rotates the assertion    | `registration_id`                         |
| `registration.expired` | Unclaimed registration past its TTL                          | `registration_id`                         |
| `registration.revoked` | SET processed at `/agent/event/notify`                       | `registration_id`, `iss`, `sub`           |

For ID-JAG flows, include `iss`, `sub`, `agent_platform`, and `agent_context_id` so operators can correlate with provider-side logs.

Services that already expose resource events (for API keys, invitations, membership, or whatever principal the service creates) should consider tagging those events with `created_by_agent: true` and a status field (`unclaimed` / `claimed` / `expired`) so consumers don't have to cross-reference the agent-registration events to determine whether a given resource is agent-related.

## Security Considerations

- **Token hashing.** The `claim_token` and `claim_attempt_token` are bearer secrets with no proof of possession — store only SHA-256 hashes. The `user_code` is held server-side and revealed on the claim page only after the user confirms. Plaintext leaves the server as: `claim_token` in the registration response to the agent, `claim_attempt_token` inside the `verification_uri` query string, and `user_code` on the claim page to the confirmed user (who relays it back to the agent). The agent submits `claim_token` + `user_code` at claim/complete.
- **user_code entropy + TTL.** Use a CSPRNG (`crypto.randomInt`) for the `user_code`. Default to a short TTL (≤10 min) and tight per-registration retry limits at `/agent/identity/claim/complete` — 6-digit codes are guess-bounded only by lockout, not entropy. Requiring the attempt to be confirmed by a signed-in user before any code is accepted removes the pre-confirmation guessing window entirely.
- **Confirm before reveal.** Only reveal the `user_code` after the signed-in user matches the attempt's `login_hint` and confirms. This is what binds the ceremony to the intended human — an intercepted `verification_uri` lands a third party on a page that won't reveal a code for someone else's `login_hint`.
- **IP logging.** Capture IPs at registration, claim start, confirm, and complete for audit trail.
- **Scope on claim endpoints.** The claim, confirm, and complete endpoints must resolve to a tenant / environment, and reject tokens that don't belong to that scope even if the hash somehow collides.
- **Refresh-token rotation.** Rotate the `refresh_token` on every exchange and reject a presented-but-spent token (a reuse signal). Store only its hash.
- **Key reuse across the claim boundary.** For anonymous, the in-place permission swap means anyone who captured the API key pre-claim retains access post-claim with the new scopes. Offer forced rotation as an opt-in for security-sensitive tenants.
- **Bulk revocation.** Provide an operator-facing mechanism to revoke all outstanding agent credentials for a tenant in one shot — for incident response.
- **Assertion replay.** Cache `jti` values for at least the assertion lifetime plus clock skew. A shared store is required if `/agent/identity` runs across multiple replicas.
- **Trust list discipline.** Treat the trusted-providers list as security-critical configuration. Changes should be audited and rolled out with the same care as any auth config change.
