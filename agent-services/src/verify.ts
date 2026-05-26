import { randomUUID } from "node:crypto";
import {
  type JWTPayload,
  type KeyLike,
  SignJWT,
  decodeProtectedHeader,
  generateKeyPair,
  jwtVerify,
} from "jose";
import { config } from "./config.js";
import { type Registration, recordJti } from "./store.js";
import { getJwks, isTrustedIssuer } from "./trust.js";

// Service signing key for internal ID-JAGs. Generated at startup; ephemeral
// across restarts. For self-bootstrapped registrations (anonymous, email-
// verification, and ID-JAG step-ups that resolve cleanly) the service acts as
// its own IdP — signs an identity_assertion that the agent then exchanges at
// /oauth2/token (RFC 7523 JWT-bearer).
const SERVICE_KEY_ID = "service-as-key-1";
const SERVICE_SIGNING_ALG = "ES256";
let serviceKeyPair: { privateKey: KeyLike; publicKey: KeyLike } | undefined;

export async function getServiceSigningKey(): Promise<{
  privateKey: KeyLike;
  publicKey: KeyLike;
  kid: string;
  alg: string;
}> {
  if (!serviceKeyPair) {
    serviceKeyPair = await generateKeyPair(SERVICE_SIGNING_ALG, {
      extractable: false,
    });
  }
  return {
    privateKey: serviceKeyPair.privateKey,
    publicKey: serviceKeyPair.publicKey,
    kid: SERVICE_KEY_ID,
    alg: SERVICE_SIGNING_ALG,
  };
}

export type VerifyError = {
  code:
    | "invalid_issuer"
    | "invalid_signature"
    | "expired"
    | "replay_detected"
    | "invalid_audience"
    | "invalid_client_id"
    | "missing_verified_email"
    | "auth_time_missing"
    | "auth_time_too_old"
    | "invalid_request";
  message: string;
};

export type IdJagClaims = JWTPayload & {
  iss: string;
  sub: string;
  aud: string;
  jti: string;
  client_id?: string;
  email?: string;
  email_verified?: boolean;
  phone_number?: string;
  phone_number_verified?: boolean;
  name?: string;
  amr?: string[];
  auth_time?: number;
  agent_platform?: string;
  agent_context_id?: string;
};

function peekIssuer(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json) as { iss?: unknown };
    return typeof payload.iss === "string" ? payload.iss : null;
  } catch {
    return null;
  }
}

export async function verifyIdJag(
  jwt: string,
): Promise<
  { ok: true; claims: IdJagClaims } | { ok: false; error: VerifyError }
> {
  const iss = peekIssuer(jwt);
  if (!iss || !isTrustedIssuer(iss)) {
    return {
      ok: false,
      error: {
        code: "invalid_issuer",
        message: `Issuer ${iss ?? "<missing>"} is not in the trusted providers list.`,
      },
    };
  }

  let header;
  try {
    header = decodeProtectedHeader(jwt);
  } catch {
    return {
      ok: false,
      error: { code: "invalid_request", message: "Malformed JWT header." },
    };
  }
  if (header.typ && header.typ !== "oauth-id-jag+jwt") {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: `Unexpected typ ${String(header.typ)}; wanted oauth-id-jag+jwt.`,
      },
    };
  }

  let claims: IdJagClaims;
  try {
    const res = await jwtVerify(jwt, getJwks(iss), {
      issuer: iss,
      audience: config.baseUrl,
      typ: "oauth-id-jag+jwt",
      clockTolerance: config.clockSkewSeconds,
    });
    claims = res.payload as IdJagClaims;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/expired|exp/i.test(message)) {
      return { ok: false, error: { code: "expired", message } };
    }
    if (/audience/i.test(message)) {
      return { ok: false, error: { code: "invalid_audience", message } };
    }
    return { ok: false, error: { code: "invalid_signature", message } };
  }

  if (!claims.jti || !claims.sub) {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "Missing required claim (jti or sub).",
      },
    };
  }

  // Freshness-of-authentication check: a token with an old auth_time means
  // the user logged in long ago at the provider, even if the token itself
  // was minted recently. Reject so the agent refreshes upstream rather than
  // riding a stale session.
  if (typeof claims.auth_time !== "number") {
    return {
      ok: false,
      error: {
        code: "auth_time_missing",
        message: "ID-JAG must include an auth_time claim.",
      },
    };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const authAge = nowSec - claims.auth_time;
  if (authAge > config.idJagMaxAuthAgeSeconds + config.clockSkewSeconds) {
    return {
      ok: false,
      error: {
        code: "auth_time_too_old",
        message: `auth_time is ${authAge}s old; max allowed is ${config.idJagMaxAuthAgeSeconds}s. Re-authenticate at the provider and request a fresh ID-JAG.`,
      },
    };
  }

  const replay = recordJti(
    claims.jti,
    claims.exp ?? Math.floor(Date.now() / 1000) + 300,
  );
  if (replay === "replay") {
    return {
      ok: false,
      error: {
        code: "replay_detected",
        message: `jti ${claims.jti} seen before.`,
      },
    };
  }

  if (!claims.email_verified && !claims.phone_number_verified) {
    return {
      ok: false,
      error: {
        code: "missing_verified_email",
        message: "ID-JAG must include a verified email or phone number.",
      },
    };
  }

  return { ok: true, claims };
}

export type ServiceIdJagInput = {
  registration: Registration;
  email?: string;
  emailVerified?: boolean;
  amr?: string[];
};

export type ServiceIdJagClaims = IdJagClaims & {
  registration_type: Registration["kind"];
};

// Mints a service-signed ID-JAG. Used by /agent/register (and the claim/
// complete handler) to issue an identity_assertion that the agent presents
// at /oauth2/token to obtain a credential.
export async function signServiceIdJag(
  input: ServiceIdJagInput,
): Promise<{ jwt: string; expiresAt: Date }> {
  const { privateKey, kid, alg } = await getServiceSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.serviceAssertionTtlSeconds;

  const claims: JWTPayload = {
    iss: config.baseUrl,
    sub: input.registration.id,
    aud: config.baseUrl,
    jti: randomUUID(),
    client_id: config.agentAuthClientId,
    registration_type: input.registration.kind,
  };
  if (input.email) claims.email = input.email;
  if (typeof input.emailVerified === "boolean") {
    claims.email_verified = input.emailVerified;
  }
  if (input.amr && input.amr.length > 0) claims.amr = input.amr;

  const jwt = await new SignJWT(claims)
    .setProtectedHeader({ alg, typ: "oauth-id-jag+jwt", kid })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);

  return { jwt, expiresAt: new Date(exp * 1000) };
}

export type ServiceIdJagVerifyError = {
  code:
    | "invalid_assertion"
    | "invalid_signature"
    | "invalid_issuer"
    | "invalid_audience"
    | "expired"
    | "replay_detected";
  message: string;
};

// Verifies a service-signed ID-JAG presented at /oauth2/token. Same JWT
// machinery as verifyIdJag, but the issuer is ourselves and the public key is
// our own — no remote JWKS fetch.
export async function verifyServiceIdJag(
  jwt: string,
): Promise<
  | { ok: true; claims: ServiceIdJagClaims }
  | { ok: false; error: ServiceIdJagVerifyError }
> {
  let header;
  try {
    header = decodeProtectedHeader(jwt);
  } catch {
    return {
      ok: false,
      error: { code: "invalid_assertion", message: "Malformed JWT header." },
    };
  }
  if (header.typ !== "oauth-id-jag+jwt") {
    return {
      ok: false,
      error: {
        code: "invalid_assertion",
        message: `Unexpected typ ${String(header.typ)}; wanted oauth-id-jag+jwt.`,
      },
    };
  }

  const { publicKey } = await getServiceSigningKey();
  let claims: ServiceIdJagClaims;
  try {
    const res = await jwtVerify(jwt, publicKey, {
      issuer: config.baseUrl,
      audience: config.baseUrl,
      typ: "oauth-id-jag+jwt",
      clockTolerance: config.clockSkewSeconds,
    });
    claims = res.payload as ServiceIdJagClaims;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/expired|exp/i.test(message)) {
      return { ok: false, error: { code: "expired", message } };
    }
    if (/audience/i.test(message)) {
      return { ok: false, error: { code: "invalid_audience", message } };
    }
    if (/issuer/i.test(message)) {
      return { ok: false, error: { code: "invalid_issuer", message } };
    }
    return { ok: false, error: { code: "invalid_signature", message } };
  }

  if (!claims.sub) {
    return {
      ok: false,
      error: {
        code: "invalid_assertion",
        message: "Missing required claim (sub).",
      },
    };
  }

  // Service-signed assertions are intentionally reusable within their TTL —
  // the agent re-calls /token with the same assertion to refresh the access
  // token. No jti dedup here; short exp is the boundary instead.

  return { ok: true, claims };
}

// Security Event Token shape per RFC 8417 §2. Receivers dispatch on the
// `events` claim, where each key is a schema URI naming an event type and
// each value carries the event-specific payload.
export type SetClaims = JWTPayload & {
  iss: string;
  sub?: string;
  aud: string;
  jti: string;
  iat: number;
  events: Record<string, unknown>;
};

export type SetVerifyError = {
  // RFC 8935 §2.4 error vocabulary.
  code:
    | "invalid_request"
    | "invalid_key"
    | "invalid_issuer"
    | "invalid_audience"
    | "authentication_failed";
  message: string;
};

// Verifies a SET delivered via RFC 8935 push. Validates the JWT against the
// transmitter's JWKS (resolved via the trust list), enforces the canonical
// typ, and rejects replays. The caller dispatches on the events claim.
export async function verifySet(
  jwt: string,
): Promise<
  { ok: true; claims: SetClaims } | { ok: false; error: SetVerifyError }
> {
  const iss = peekIssuer(jwt);
  if (!iss || !isTrustedIssuer(iss)) {
    return {
      ok: false,
      error: {
        code: "invalid_issuer",
        message: `Issuer ${iss ?? "<missing>"} is not in the trusted providers list.`,
      },
    };
  }

  let header;
  try {
    header = decodeProtectedHeader(jwt);
  } catch {
    return {
      ok: false,
      error: { code: "invalid_request", message: "Malformed JWT header." },
    };
  }
  if (header.typ !== "secevent+jwt") {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: `Unexpected typ ${String(header.typ)}; wanted secevent+jwt.`,
      },
    };
  }

  let claims: SetClaims;
  try {
    const res = await jwtVerify(jwt, getJwks(iss), {
      issuer: iss,
      audience: config.baseUrl,
      typ: "secevent+jwt",
      clockTolerance: config.clockSkewSeconds,
    });
    claims = res.payload as SetClaims;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/audience/i.test(message)) {
      return { ok: false, error: { code: "invalid_audience", message } };
    }
    return { ok: false, error: { code: "authentication_failed", message } };
  }

  if (!claims.jti) {
    return {
      ok: false,
      error: { code: "invalid_request", message: "Missing required jti." },
    };
  }
  if (!claims.events || typeof claims.events !== "object") {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "Missing or malformed events claim.",
      },
    };
  }

  const replay = recordJti(
    claims.jti,
    claims.exp ?? Math.floor(Date.now() / 1000) + 300,
  );
  if (replay === "replay") {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: `jti ${claims.jti} seen before.`,
      },
    };
  }

  return { ok: true, claims };
}
