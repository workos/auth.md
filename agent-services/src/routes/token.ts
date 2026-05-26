import express, { Router } from "express";
import { config } from "../config.js";
import { parseBody, tokenEndpointBody } from "../schemas.js";
import { issueAccessToken, registrations } from "../store.js";
import { verifyServiceIdJag } from "../verify.js";

// RFC 7523 JWT-bearer grant at /oauth2/token. The agent presents a service-
// signed identity_assertion (minted by /agent/register or /agent/register/
// claim/complete) and receives a standard OAuth access_token.
//
// Errors at this endpoint use OAuth-standard vocabulary (RFC 6749 §5.2 and
// RFC 9470). Anything assertion-related collapses to `invalid_grant`;
// step-up-required collapses to `insufficient_user_authentication`.

export const tokenRouter = Router();

// /oauth2/token requires form-encoded request bodies per RFC 6749 §4.5 /
// RFC 7523 §2.1. Scope locally so JSON body-parsing at the app level isn't
// disturbed.
const formParser = express.urlencoded({ extended: false });

type OAuthErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "invalid_client"
  | "unsupported_grant_type"
  | "insufficient_user_authentication";

function oauthError(
  res: express.Response,
  status: number,
  code: OAuthErrorCode,
  description: string,
): void {
  res.status(status).json({ error: code, error_description: description });
}

tokenRouter.post(config.tokenEndpointPath, formParser, async (req, res) => {
  const parsed = parseBody(tokenEndpointBody, req.body);
  if (!parsed.ok) {
    oauthError(res, 400, "invalid_request", parsed.message);
    return;
  }
  const { assertion } = parsed.value;

  const verification = await verifyServiceIdJag(assertion);
  if (!verification.ok) {
    const { code, message } = verification.error;
    // Any signature/expiry/audience failure on the presented assertion maps
    // to invalid_grant — RFC 6749 §5.2 collapses these into one OAuth code.
    console.warn(`[token] assertion rejected: ${code}: ${message}`);
    oauthError(res, 400, "invalid_grant", message);
    return;
  }
  const { claims } = verification;

  const registration = registrations.get(claims.sub);
  if (!registration) {
    console.warn(`[token] no registration for sub=${claims.sub}`);
    oauthError(
      res,
      400,
      "invalid_grant",
      "The registration referenced by this assertion does not exist.",
    );
    return;
  }

  if (registration.status === "expired") {
    console.warn(`[token] registration ${registration.id} expired`);
    oauthError(
      res,
      400,
      "invalid_grant",
      "The registration has expired. Re-register at /agent/register.",
    );
    return;
  }

  // email_verification and id_jag registrations have no credential
  // path until their claim ceremony completes — block /token issuance until
  // the agent routes through claim. Anonymous registrations always have a
  // credential path; the claim only upgrades scope.
  if (registration.kind !== "anonymous" && registration.status !== "claimed") {
    console.warn(
      `[token] registration ${registration.id} (${registration.kind}) requires claim before issuing credential`,
    );
    oauthError(
      res,
      401,
      "insufficient_user_authentication",
      "The registration requires user interaction to claim before a credential can be issued.",
    );
    return;
  }

  // Only anonymous-pre-claim gets the restricted scope set. Everything else
  // — anonymous after claim, plus any non-anonymous registration (which can
  // only reach this branch when claimed) — gets the full granted set.
  const isAnonymousPreClaim =
    registration.kind === "anonymous" && registration.status !== "claimed";

  const scope = isAnonymousPreClaim
    ? config.preClaimScopes
    : config.postClaimScopes;

  const source =
    registration.kind === "anonymous"
      ? ("anonymous" as const)
      : registration.kind === "email_verification"
        ? ("email_verification" as const)
        : ("identity_assertion" as const);

  const credential = issueAccessToken({
    userId: registration.user_id,
    scope,
    source,
    registrationId: registration.id,
    iss: registration.id_jag?.iss,
    sub: registration.id_jag?.sub,
    aud: registration.id_jag?.aud,
  });

  console.log(
    `[token] issued access_token for registration=${registration.id} kind=${registration.kind} status=${registration.status} scope=${scope.join(",")}`,
  );

  const expiresIn = credential.expires_at
    ? Math.max(
        0,
        Math.floor((credential.expires_at.getTime() - Date.now()) / 1000),
      )
    : undefined;

  // Standard OAuth token response per RFC 6749 §5.1.
  const body: Record<string, unknown> = {
    access_token: credential.token,
    token_type: "Bearer",
    scope: scope.join(" "),
  };

  if (typeof expiresIn === "number") body.expires_in = expiresIn;

  res.json(body);
});
