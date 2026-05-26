# auth.md

A reference implementation of **agentic registration** — a protocol for agents to authenticate to services on behalf of users. Three roles: an **agent** acting for a user, an **agent provider** that mints identity assertions (ID-JAGs), and a **service** that accepts those assertions, when available, and issues credentials. If the agent is not associated with a user identity, or the agent provider does not support ID-JAGs, the service uses an OTP-based claim flow to authenticate the agent instead.

This repo includes sample implementations for both the agent provider and agent service side of agentic registration, and includes a sample [`AUTH.md`](AUTH.md) file, which the agent service would host, instructing agents how to authenticate with the service.

## Layout

```
.
├── AUTH.md            ← skill manifest agents read
├── agent-services/    ← sample resource server + authorization server
├── agent-providers/   ← sample agent IdP that mints ID-JAGs
└── shared/            ← shared workspace package (ports, types)
```

## Where to go next

- **You're an agent or want an auth.md template** → [AUTH.md](AUTH.md) — procedural recipe (discover → register → claim → use → handle revoke).
- **You're implementing a service** → [agent-services/README.md](agent-services/README.md) — full implementation guide, sequence diagrams, error tables.
- **You're implementing an IdP** → [agent-providers/README.md](agent-providers/README.md) — minting ID-JAGs, publishing JWKS, sending revocation events.

## Quickstart

```sh
pnpm install
pnpm dev
```

Service at <http://localhost:8000>, provider at <http://localhost:4000>. The service home page walks the three registration flows interactively. Use `pnpm dev:service` or `pnpm dev:provider` to run one side at a time.

## System Flows

Three registration flows share the `/agent/register` endpoint. Pick the one that matches what the agent has on hand. All three converge at `/oauth2/token`, which exchanges a service-signed identity assertion for an access_token via [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523) JWT-bearer grant.

### Discovery

Hosted at `/.well-known/oauth-authorization-server`:

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

### Identity Assertion (ID-JAG)

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

    Agent->>Service: POST /agent/register<br/>{ type: identity_assertion, assertion: ID-JAG }
    Service->>Provider: GET /.well-known/jwks.json
    Provider-->>Service: 200 OK (JSON Web Key Set)
    Service->>Service: Verify signature + claims, match user
    Service-->>Agent: 200 OK (identity_assertion)
    Agent->>Service: POST /oauth2/token<br/>grant_type=jwt-bearer&assertion=...
    Service-->>Agent: 200 OK (access_token)
```

### Anonymous Registration + OTP Claim

```mermaid
sequenceDiagram
    actor User
    participant Agent
    participant Service

    Agent->>Service: POST /agent/register<br/>{ type: anonymous }
    Service->>Service: Create agent principal, claim record
    Service-->>Agent: 200 OK (identity_assertion, claim_token)
    Agent->>Service: POST /oauth2/token<br/>grant_type=jwt-bearer&assertion=...
    Service-->>Agent: 200 OK (access_token at pre-claim scopes)

    Note over Agent: Agent operates with pre-claim scopes

    User-->>Agent: Wants to take ownership
    Agent->>Service: POST /agent/register/claim<br/>{ claim_token, email }
    Service->>User: Send claim-view email (one-time URL)
    User->>Service: GET /agent/register/claim/view?token=...
    Service-->>User: 6-digit OTP page
    User-->>Agent: Reads OTP back
    Agent->>Service: POST /agent/register/claim/complete<br/>{ claim_token, otp }
    Service->>Service: Upgrade scope of access_tokens issued from this registration
    Service-->>Agent: 200 OK { status: claimed }
```

### Verified-Email Identity Assertion

```mermaid
sequenceDiagram
    actor User
    participant Agent
    participant Service

    Agent->>Service: POST /agent/register<br/>{ type: identity_assertion, assertion_type: verified_email, assertion: email }
    Service->>User: Send claim-view email (one-time URL)
    Service-->>Agent: 200 OK (claim_token, no identity_assertion yet)
    User->>Service: GET /agent/register/claim/view?token=...
    Service-->>User: 6-digit OTP page
    User-->>Agent: Reads OTP back
    Agent->>Service: POST /agent/register/claim/complete<br/>{ claim_token, otp }
    Service-->>Agent: 200 OK (identity_assertion)
    Agent->>Service: POST /oauth2/token<br/>grant_type=jwt-bearer&assertion=...
    Service-->>Agent: 200 OK (access_token)
```
