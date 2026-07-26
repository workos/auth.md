import express, { Router } from "express";
import { config } from "../config.js";
import {
  claimGrantBody,
  jwtBearerGrantBody,
  parseBody,
  revocationEndpointBody,
} from "../schemas.js";
import {
  type Registration,
  findRegistrationByClaimHash,
  findRegistrationById,
  issueAccessToken,
  revokeCredential,
  sha256Hex,
  users,
} from "../store.js";
import { signServiceIdJag, verifyServiceIdJag } from "../verify.js";

/*
 * OAuth credential surface for the agent-auth profile.
 *
 * /oauth2/token handles two grants, dispatched on grant_type:
 *   - urn:ietf:params:oauth:grant-type:jwt-bearer (RFC 7523) — exchanges a
 *     service-signed identity_assertion for an access_token. The assertion's
 *     `sub` resolves to a registration; the scope set is derived from the
 *     registration's state.
 *   - urn:workos:agent-auth:grant-type:claim — profile-specific grant for
 *     claim-ceremony polling. Borrows RFC 8628 §3.5 semantics (returns
 *     authorization_pending while waiting, expired_token on closed window,
 *     standard OAuth token response on completion + identity_assertion
 *     extension). Uses a custom URN rather than the IANA device_code grant
 *     so it doesn't collide with services that also implement standard
 *     device authorization at the same endpoint.
 *
 * /oauth2/revoke (RFC 7009) — kills a single access_token by value. 200 on
 * success, idempotent, no enumeration leakage on unknown tokens.
 */

export const tokenRouter = Router();

const formParser = express.urlencoded({ extended: false });

const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/**
 * Profile-specific grant URN for claim-ceremony polling. Custom (not IANA-
 * registered) so it doesn't collide with services that also implement
 * standard RFC 8628 device authorization at the same token endpoint —
 * routing happens at grant_type, not by inspecting the bearer value.
 */
const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";

type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  /** Borrowed from RFC 8628 §3.5 for the device-auth-shaped claim grant. */
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token";

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
  if (grantType === CLAIM_GRANT) {
    return handleClaimGrant(req, res);
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
  /*
   * Identity-bound (non-anonymous) registrations only mint tokens once the
   * user has confirmed ownership (status: claimed). A `pending_claim` or
   * `unclaimed` id_jag/service_auth registration predates confirmation —
   * e.g. a revoked binding revived by a step-up ceremony that the user has
   * not yet re-approved — so a surviving pre-revocation identity_assertion
   * must not exchange for a credential here. Anonymous registrations
   * legitimately exchange pre-claim (capped to preClaimScopes below).
   */
  if (registration.kind !== "anonymous" && registration.status !== "claimed") {
    oauthError(
      res,
      "invalid_grant",
      `The registration is not claimed. Complete the confirmation ceremony at ${config.claimEndpointPath}.`,
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

async function handleClaimGrant(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const parsed = parseBody(claimGrantBody, req.body);
  if (!parsed.ok) {
    oauthError(res, "invalid_request", parsed.message);
    return;
  }

  const registration = findRegistrationByClaimHash(
    sha256Hex(parsed.value.claim_token),
  );
  if (!registration) {
    oauthError(res, "expired_token", "Unknown or expired claim_token.");
    return;
  }
  if (registration.status === "expired") {
    oauthError(res, "expired_token", "The claim ceremony window has closed.");
    return;
  }
  if (registration.status !== "claimed") {
    /*
     * The user_code itself expires faster than the outer claim window
     * (userCodeTtlSeconds vs claim.expires_at). If the user_code window
     * has closed but the registration is still active, the form-action
     * endpoint would refuse a submission and the agent would otherwise
     * poll authorization_pending until the outer window expires. Return
     * expired_token so the agent knows to re-mint via /agent/identity/claim.
     */
    const attempt = registration.claim?.attempt;
    if (attempt && attempt.user_code_expires_at.getTime() < Date.now()) {
      oauthError(
        res,
        "expired_token",
        "The user_code window has closed. Re-initiate the claim ceremony at the claim_endpoint.",
      );
      return;
    }
    /*
     * RFC 8628 §3.5: while the user hasn't completed the ceremony, return
     * authorization_pending. The agent is expected to retry after
     * `interval` seconds.
     *
     * A production service should also issue `slow_down` here when it
     * detects polling faster than `interval` — typically by recording the
     * last-poll timestamp per claim_token (Redis SETEX or similar) and
     * returning `slow_down` when the gap is below the advertised cadence.
     * Omitted from this demo to keep the store in-memory; the error code
     * is declared in OAuthErrorCode so callers can branch on it if added.
     */
    oauthError(
      res,
      "authorization_pending",
      "The user has not yet completed the ceremony.",
    );
    return;
  }

  const credential = issueAccessTokenForRegistration(registration);
  /*
   * Mint a fresh "v2" identity_assertion that reflects the post-claim
   * state — for anonymous, this is the first time we know the user's
   * email; the v1 assertion the agent already holds has no identity
   * claims. The agent uses v2 for future jwt-bearer refreshes.
   */
  const user = registration.user_id
    ? users.get(registration.user_id)
    : undefined;
  const { jwt, expiresAt } = await signServiceIdJag({
    registration,
    email: user?.email,
    emailVerified: user?.email_verified,
  });

  console.log(
    `[token] claim grant succeeded for registration=${registration.id}; issued access_token + v2 assertion`,
  );
  setOAuthHeaders(res);
  res.json({
    ...tokenResponse(credential),
    identity_assertion: jwt,
    assertion_expires: expiresAt.toISOString(),
  });
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
