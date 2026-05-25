import { type JWTPayload, decodeProtectedHeader, jwtVerify } from "jose";
import { config } from "./config.js";
import { recordJti } from "./store.js";
import { getJwks, isTrustedIssuer } from "./trust.js";

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

export type LogoutClaims = JWTPayload & {
  iss: string;
  sub: string;
  aud: string;
  jti: string;
  events: Record<string, unknown>;
};

export async function verifyLogoutJwt(
  jwt: string,
): Promise<
  { ok: true; claims: LogoutClaims } | { ok: false; error: VerifyError }
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
  try {
    const res = await jwtVerify(jwt, getJwks(iss), {
      issuer: iss,
      audience: config.baseUrl,
      typ: "logout+jwt",
      clockTolerance: config.clockSkewSeconds,
    });
    const claims = res.payload as LogoutClaims;
    if (!claims.jti || !claims.sub) {
      return {
        ok: false,
        error: {
          code: "invalid_request",
          message: "Missing required claim (jti or sub).",
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
    return { ok: true, claims };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { code: "invalid_signature", message } };
  }
}
