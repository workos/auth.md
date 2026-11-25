import express, { Router } from "express";
import { config } from "../config.js";
import {
  jwtBearerGrantBody,
  parseBody,
  revocationEndpointBody,
} from "../schemas.js";
import {
  type Registration,
  findRegistrationById,
  issueAccessToken,
  revokeCredential,
} from "../store.js";
import { verifyServiceIdJag } from "../verify.js";

/*
 * OAuth credential surface for the agent-auth profile.
 *
 * /oauth2/token handles one grant:
 *   - urn:ietf:params:oauth:grant-type:jwt-bearer (RFC 7523) — exchanges a
 *     service-signed identity assertion for an access_token. The assertion's
 *     `sub` resolves to a registration; the scope set is derived from the
 *     registration's state. The claim ceremony does not run through here —
 *     the agent completes it at /agent/identity/claim/complete and gets a
 *     refresh token for the assertion refresh path.
 *
 * /oauth2/revoke (RFC 7009) — kills a single access_token by value. 200 on
 * success, idempotent, no enumeration leakage on unknown tokens.
 */

export const tokenRouter = Router();

const formParser = express.urlencoded({ extended: false });

const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "access_denied";

/**
 * Per RFC 6749 §5.1, the AS MUST set Cache-Control: no-store and Pragma:
 * no-cache on responses containing tokens or other sensitive data. Apply to
 * every response from the token endpoint, success and error alike.
 */
function setOAuthHeaders(res: express.Response): void {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
}

function oauthError(
  res: express.Response,
  code: OAuthErrorCode,
  description: string,
): void {
  const status = code === "invalid_client" ? 401 : 400;
  setOAuthHeaders(res);
  res.status(status).json({ error: code, error_description: description });
}

tokenRouter.post(config.tokenEndpointPath, formParser, async (req, res) => {
  const grantType =
    typeof req.body?.grant_type === "string" ? req.body.grant_type : undefined;

  if (grantType === JWT_BEARER_GRANT) {
    return handleJwtBearerGrant(req, res);
  }
  return oauthError(
    res,
    "unsupported_grant_type",
    grantType ? `Unsupported grant_type: ${grantType}.` : "Missing grant_type.",
  );
});

async function handleJwtBearerGrant(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const parsed = parseBody(jwtBearerGrantBody, req.body);
  if (!parsed.ok) {
    oauthError(res, "invalid_request", parsed.message);
    return;
  }

  const verified = await verifyServiceIdJag(parsed.value.assertion);
  if (!verified.ok) {
    oauthError(res, "invalid_grant", verified.error.message);
    return;
  }

  const registration = findRegistrationById(verified.claims.sub);
  if (!registration) {
    oauthError(
      res,
      "invalid_grant",
      `No registration found for sub=${verified.claims.sub}.`,
    );
    return;
  }
  if (registration.status === "expired") {
    oauthError(
      res,
      "invalid_grant",
      `The registration has expired. Re-register at ${config.identityEndpointPath}.`,
    );
    return;
  }

  const credential = issueAccessTokenForRegistration(registration);
  console.log(
    `[token] jwt-bearer issued access_token for registration=${registration.id} status=${registration.status}`,
  );
  setOAuthHeaders(res);
  res.json(tokenResponse(credential));
}

function issueAccessTokenForRegistration(registration: Registration) {
  /*
   * Anonymous registrations stay on pre-claim scopes until a human has
   * actually confirmed ownership (status: claimed). `unclaimed` and
   * `pending_claim` both predate confirmation — the latter means the
   * agent has kicked off a claim ceremony but the user hasn't yet
   * approved it, so the pre-claim cap still applies. Email-verification
   * registrations always reach /oauth2/token via a post-claim
   * identity_assertion (the registration is bound to a user before the
   * assertion is minted), so they get the full set.
   */
  const scope =
    registration.kind === "anonymous" && registration.status !== "claimed"
      ? config.preClaimScopes
      : config.scopesSupported;

  return issueAccessToken({
    userId: registration.user_id,
    scope,
    source: sourceForRegistrationKind(registration.kind),
    iss: registration.id_jag?.iss,
    sub: registration.id_jag?.sub,
    aud: registration.id_jag?.aud,
    registrationId: registration.id,
  });
}

function tokenResponse(credential: {
  token: string;
  scope: string[];
  expires_at?: Date;
}): Record<string, unknown> {
  const expiresIn = credential.expires_at
    ? Math.max(
        0,
        Math.floor((credential.expires_at.getTime() - Date.now()) / 1000),
      )
    : config.accessTokenTtlSeconds;
  return {
    access_token: credential.token,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: credential.scope.join(" "),
  };
}

tokenRouter.post(config.revocationEndpointPath, formParser, (req, res) => {
  const parsed = parseBody(revocationEndpointBody, req.body);
  if (!parsed.ok) {
    return oauthError(res, "invalid_request", parsed.message);
  }
  const revoked = revokeCredential(parsed.value.token);
  console.log(
    `[token] revocation ${revoked ? "applied" : "no-op"} for token=${parsed.value.token.slice(0, 8)}...`,
  );
  setOAuthHeaders(res);
  res.status(200).end();
});

function sourceForRegistrationKind(
  kind: "anonymous" | "service_auth" | "id_jag",
): "anonymous" | "service_auth" | "identity_assertion" {
  if (kind === "id_jag") return "identity_assertion";
  return kind;
}
