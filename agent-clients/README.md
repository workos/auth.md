# @workos/auth.md-client

The agent-side client for the [auth.md](../AUTH.md) agentic registration
protocol. It collapses the full ceremony — discovery, registration, claim,
jwt-bearer exchange, refresh — into a couple of deterministic tool calls,
instead of asking the model to drive each HTTP request itself.

Three pieces, one shared core:

```
src/core/   discovery → register → claim → exchange → refresh, credential store
src/mcp/    stdio MCP server (Claude Desktop, Claude Code, Codex)
src/pi/     pi extension adapter calling the core directly
mcpb/       manifest for the Claude Desktop .mcpb bundle
```

## Tools

All state is tenanted by `issuer` — one client holds independent
registrations across many services.

- **`authmd_authenticate(issuer, email?, resource?, id_jag?)`** — reuses
  stored credentials when possible (cached access_token → live assertion →
  refresh token), otherwise registers with the lightest applicable method:
  `identity_assertion` when an ID-JAG is supplied, `service_auth` when an
  email is given, `anonymous` otherwise. Returns ready credentials, or
  `{ status: "claim_required", verification_uri }` when the user has to
  confirm in a browser.
- **`authmd_complete_claim(issuer, user_code)`** — finishes the ceremony
  with the code the user read back from the claim page, persists the
  post-claim identity (assertion + rotating refresh token), and exchanges
  for an access token.
- **`authmd_fetch(issuer, url, ...)`** — convenience wrapper that injects
  the bearer token and transparently refreshes expired credentials.

Claim tokens are held in memory only for the duration of the ceremony, per
the spec. Identity assertions, refresh tokens, and access tokens persist in
a `0600` JSON file at `~/.authmd/credentials.json` (override with
`AUTHMD_STORE_PATH`). The store is behind a `CredentialStore` interface so
an OS-keychain backend can be swapped in without touching the client.

## Trust model

The client runs locally on the agent's machine, and tool inputs are trusted
as the agent's own choices:

- **`issuer` is trusted input.** Discovery fetches the issuer the caller
  names, including `localhost` and private-network hosts (the sample
  service runs on `localhost:8000`). If you embed the core where issuer
  values can be influenced by untrusted prompts or content, enforce an
  issuer allowlist in your adapter before calling the client.
- **Tokens are agent credentials, not secrets from the agent.**
  `authmd_authenticate` / `authmd_complete_claim` return the access token
  plainly, and `authmd_fetch` sends it to the URL the caller supplies —
  it's a convenience wrapper, not a security boundary. The credential file
  exists for persistence/reuse across sessions, not to hide tokens.

## Install

MCP hosts (after `pnpm build`, or via npm once published):

```sh
# Claude Code
claude mcp add authmd -- node <repo>/agent-clients/dist/mcp/server.js

# Codex
codex mcp add authmd -- node <repo>/agent-clients/dist/mcp/server.js
```

Claude Desktop: pack `manifest.json` + `dist/` with the `mcpb` CLI and
double-click the resulting `.mcpb`.

pi: the adapter in `src/pi/` default-exports an `activate(pi)` that
registers the same three tools via `pi.registerTool()`.

Hermes ([hermes-agent](https://hermes-agent.nousresearch.com)): add the
stdio server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  authmd:
    command: "node"
    args: ["<repo>/agent-clients/dist/mcp/server.js"]
    # or, once published: command: "npx", args: ["-y", "@workos/auth.md-client"]
```

## Try it against the sample service

```sh
pnpm dev          # from the repo root: starts provider (4000) + service (8000)
```

Then point any of the tools at `http://localhost:8000` as the issuer.
