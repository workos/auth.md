# auth.md

A reference implementation of **agentic registration** — a protocol for agents to authenticate to services on behalf of users. Three roles: an **agent** acting for a user, an **agent provider** that mints identity assertions ([ID-JAGs](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/)), and a **service** that accepts those assertions, when available, and issues credentials. If the agent is not associated with a user identity, or the agent provider does not support ID-JAGs, the service uses an [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)-style claim ceremony to authenticate the agent instead.

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

- **You're an agent or want an auth.md template** → [AUTH.md](AUTH.md) — procedural recipe (discover → register → claim → exchange → use → handle revoke).
- **You're implementing a service** → [agent-services/README.md](agent-services/README.md) — full implementation guide, sequence diagrams, error tables.
- **You're implementing an IdP** → [agent-providers/README.md](agent-providers/README.md) — minting ID-JAGs, publishing JWKS, sending revocation events.

## Quickstart

```sh
pnpm install
pnpm dev
```

Service at <http://localhost:8000>, provider at <http://localhost:4000>. The service home page walks the three registration flows interactively. Use `pnpm dev:service` or `pnpm dev:provider` to run one side at a time.

## System Flows

Registration and credential issuance are split across two endpoints. `POST /agent/identity` accepts the agent's chosen identity type (ID-JAG, service_auth via email, or anonymous). ID-JAG and anonymous return a service-signed `identity.assertion` immediately; service_auth returns a claim ceremony to run first. The agent then exchanges the assertion at `POST /oauth2/token` (RFC 7523 JWT-bearer grant) for an access_token.

### Discovery

Hosted at `/.well-known/oauth-authorization-server`:

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

The top-level `issuer` / `token_endpoint` / `revocation_endpoint` / `grant_types_supported` are standard [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) / [RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009) / [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523) fields. The `agent_auth` block is the profile extension carrying the registration and claim surface.

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

    Agent->>Service: POST /agent/identity<br/>{ type: identity_assertion, assertion: ID-JAG }
    Service->>Provider: GET /.well-known/jwks.json
    Provider-->>Service: 200 OK (JSON Web Key Set)
    Service-->>Agent: 200 OK (identity.assertion)

    Agent->>Service: POST /oauth2/token<br/>grant_type=jwt-bearer&assertion=...
    Service-->>Agent: 200 OK (access_token)
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
    User->>Service: GET verification_uri (signs in, lands on /agent-claim)
    Service-->>User: Reveals user_code on the page
    User-->>Agent: Reads user_code back
    Agent->>Service: POST /agent/identity/claim/complete<br/>{ claim_token, user_code }
    alt user_code correct & confirmed
      Service-->>Agent: 200 OK (identity.assertion + refresh_token)
    else user_code window expired
      Service-->>Agent: 410 user_code_expired
      Agent->>Service: POST /agent/identity/claim<br/>{ type: service_auth, claim_token, login_hint }
      Service-->>Agent: 200 OK (fresh attempt.verification_uri)
      Agent-->>User: Surface new verification_uri
    end
    Agent->>Service: POST /oauth2/token<br/>grant_type=jwt-bearer&assertion=...
    Service-->>Agent: 200 OK (access_token)
```

### Anonymous Registration with Claim Ceremony

```mermaid
sequenceDiagram
    actor User
    participant Agent
    participant Service

    Agent->>Service: POST /agent/identity<br/>{ type: anonymous }
    Service-->>Agent: 200 OK (identity.assertion, claim.token)
    Agent->>Service: POST /oauth2/token<br/>grant_type=jwt-bearer&assertion=...
    Service-->>Agent: 200 OK (access_token with pre-claim scope)

    Note over Agent: Agent operates with pre-claim scopes

    User-->>Agent: Wants to take ownership
    Agent->>Service: POST /agent/identity/claim<br/>{ type: service_auth, claim_token, login_hint }
    Service-->>Agent: 200 OK (attempt.verification_uri)
    Agent-->>User: Surface verification_uri (no code)
    User->>Service: GET verification_uri (signs in, lands on /agent-claim)
    Service-->>User: Reveals user_code on the page
    User-->>Agent: Reads user_code back
    Agent->>Service: POST /agent/identity/claim/complete<br/>{ claim_token, user_code }
    Service-->>Agent: 200 OK (v2 identity.assertion + refresh_token)
    Agent->>Service: POST /oauth2/token<br/>grant_type=jwt-bearer&assertion=...
    Service-->>Agent: 200 OK (post-claim access_token)
```
