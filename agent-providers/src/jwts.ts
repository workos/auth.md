import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { sign } from "./keys.js";
import type { User } from "./store.js";

type IdJagInput = {
  user: User;
  audience: string;
  resource?: string;
  agentPlatform?: string;
  agentContextId?: string;
};

type IdJagResult = {
  jwt: string;
  jti: string;
  expiresIn: number;
};

export async function mintIdJag(input: IdJagInput): Promise<IdJagResult> {
  const { user, audience, resource, agentPlatform, agentContextId } = input;
  const jti = randomUUID();
  const expiresIn = config.idJagTtlSeconds;

  const payload: Record<string, unknown> = {
    iss: config.issuer,
    sub: user.id,
    aud: audience,
    client_id: config.cimdUrl,
    jti,
    email: user.email,
    email_verified: user.email_verified,
  };
  if (user.amr) payload.amr = user.amr;
  if (user.auth_time)
    payload.auth_time = Math.floor(user.auth_time.getTime() / 1000);
  if (user.name) payload.name = user.name;
  if (user.phone_number) payload.phone_number = user.phone_number;
  if (typeof user.phone_number_verified === "boolean") {
    payload.phone_number_verified = user.phone_number_verified;
  }
  if (resource) payload.resource = resource;
  if (agentPlatform) payload.agent_platform = agentPlatform;
  if (agentContextId) payload.agent_context_id = agentContextId;

  const jwt = await sign(payload, "oauth-id-jag+jwt", expiresIn);
  return { jwt, jti, expiresIn };
}

// Mints a Security Event Token (RFC 8417) carrying an
// identity-assertion-revoked event. Sent via RFC 8935 push delivery to the
// consumer's events_endpoint when a grant is revoked.
export async function mintLogoutJwt(input: {
  user: User;
  audience: string;
}): Promise<string> {
  const payload = {
    iss: config.issuer,
    sub: input.user.id,
    aud: input.audience,
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    events: {
      "https://schemas.workos.com/events/agent/identity/assertion/revoked": {},
    },
  };
  return sign(payload, "secevent+jwt");
}
