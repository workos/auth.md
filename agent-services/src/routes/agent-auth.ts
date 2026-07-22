import express, { Router } from "express";
import { config } from "../config.js";
import { matchOrProvision } from "../matcher.js";
import { agentAuthBody, claimBody, parseBody } from "../schemas.js";
import {
  type Registration,
  classifyLoginHint,
  createAnonymousRegistration,
  createServiceAuthRegistration,
  findOrCreateIdJagRegistration,
  findRegistrationByClaimHash,
  recordClaimAttempt,
  revokeForDelegation,
  sha256Hex,
} from "../store.js";
import {
  type IdJagClaims,
  type VerifyError,
  signServiceIdJag,
  verifyIdJag,
  verifySecEventJwt,
} from "../verify.js";

/*
 * Agent-facing endpoints. The user-facing claim ceremony — the page where
 * the user signs in and types the user_code — lives in routes/login.ts and
 * routes/claim.ts. The agent never reaches those; it polls /oauth2/token
 * with the claim grant (urn:workos:agent-auth:grant-type:claim).
 *
 * Three response shapes from POST /agent/identity for ID-JAG flows:
 *   - clean match → 200 with identity_assertion
 *   - step-up required → 401 interaction_required with ceremony block
 *   - login_required → 401 login_required (auth_time missing or stale;
 *     agent re-mints upstream)
 */

export const agentAuthRouter = Router();

agentAuthRouter.post(config.identityEndpointPath, async (req, res) => {
  const parsed = parseBody(agentAuthBody, req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_request", message: parsed.message });
    return;
  }

  if (parsed.value.type === "identity_assertion") {
    return handleIdJagAssertion(parsed.value, res);
  }
  if (parsed.value.type === "service_auth") {
    return handleServiceAuth(parsed.value, res);
  }

  const { registration, claimTokenPlaintext } = createAnonymousRegistration();
  const { jwt, expiresAt } = await signServiceIdJag({ registration });
  console.log(
    `[agent-auth] registered anonymous agent registration=${registration.id}`,
  );
  res.json({
    registration_id: registration.id,
    registration_type: "anonymous",
    identity_assertion: jwt,
    assertion_expires: expiresAt.toISOString(),
    pre_claim_scopes: config.preClaimScopes,
    claim_url: `${config.baseUrl}${config.claimEndpointPath}`,
    claim_token: claimTokenPlaintext,
    claim_token_expires: registration.claim!.expires_at.toISOString(),
    post_claim_scopes: config.postClaimScopes,
  });
});

async function handleIdJagAssertion(
  body: { assertion: string },
  res: express.Response,
): Promise<void> {
  const verified = await verifyIdJag(body.assertion);
  if (!verified.ok) {
    return handleIdJagVerifyError(verified.error, res);
  }
  const { claims } = verified;
  const match = matchOrProvision(claims);

  if (match.kind === "step_up_required") {
    return handleIdJagStepUp(claims, match.matched_user.email, res);
  }

  const result = findOrCreateIdJagRegistration({
    iss: claims.iss,
    sub: claims.sub,
    aud: claims.aud,
    context: { user: match.user },
  });
  /*
   * Clean-match path always returns kind: "ready". The step_up_required
   * branch above is what produces ceremony blocks.
   */
  if (result.kind !== "ready") {
    throw new Error("clean match returned non-ready result");
  }
  return emitIdJagSuccess(res, result.registration, claims);
}

async function emitIdJagSuccess(
  res: express.Response,
  registration: Registration,
  claims: IdJagClaims,
): Promise<void> {
  const { jwt, expiresAt } = await signServiceIdJag({
    registration,
    email: claims.email,
    emailVerified: claims.email_verified,
    amr: claims.amr,
  });
  console.log(
    `[agent-auth] issued identity_assertion to user=${registration.user_id} via iss=${claims.iss} sub=${claims.sub} registration=${registration.id}`,
  );
  res.json({
    registration_id: registration.id,
    registration_type: "identity_assertion",
    identity_assertion: jwt,
    assertion_expires: expiresAt.toISOString(),
    scopes: config.scopesSupported,
  });
}

/**
 * Step-up: the ID-JAG matched an existing account by email/phone but no
 * (iss, sub) delegation exists. Mint the ceremony and return a 401 with
 * the OIDC-vocabulary `interaction_required` error so the agent knows to
 * surface the user_code + verification_uri to the user. The user signs in
 * at the service, sees a provider-aware confirmation page, types the code,
 * and the next agent poll picks up the bound delegation.
 */
async function handleIdJagStepUp(
  claims: IdJagClaims,
  matchedEmail: string,
  res: express.Response,
): Promise<void> {
  const result = findOrCreateIdJagRegistration({
    iss: claims.iss,
    sub: claims.sub,
    aud: claims.aud,
    context: { email: matchedEmail },
  });
  if (result.kind === "ready") {
    /*
     * Race resolution: a concurrent step-up ceremony bound the delegation
     * while this request was matching. Emit the same 200 + identity_assertion
     * the clean-match path would, instead of asking the agent to retry.
     */
    return emitIdJagSuccess(res, result.registration, claims);
  }

  console.log(
    `[agent-auth] step-up required for iss=${claims.iss} sub=${claims.sub} via email=${matchedEmail}; registration=${result.registration.id}`,
  );

  res
    .status(401)
    .set(
      "WWW-Authenticate",
      `AgentAuth error="interaction_required", error_description="ID-JAG matches existing account; user confirmation required to bind delegation"`,
    )
    .json({
      error: "interaction_required",
      error_description:
        "This ID-JAG matches an existing account. Surface the user_code + verification_uri so the user can confirm linking the provider identity to their account.",
      registration_id: result.registration.id,
      registration_type: "identity_assertion",
      claim_url: `${config.baseUrl}${config.claimEndpointPath}`,
      claim_token: result.claimTokenPlaintext,
      claim_token_expires: result.registration.claim!.expires_at.toISOString(),
      post_claim_scopes: config.scopesSupported,
      claim: buildCeremonyBlock({
        claimViewTokenPlaintext: result.claimViewTokenPlaintext,
        userCode: result.userCode,
        userCodeExpiresAt: result.userCodeExpiresAt,
      }),
    });
}

/**
 * Translate verifier error codes into the right HTTP shape. auth_time
 * problems get 401 `login_required` (OIDC vocabulary) — the agent has to
 * go back to its provider with prompt=login and re-mint a fresh ID-JAG.
 * Everything else stays 400 with the profile-specific code.
 */
function handleIdJagVerifyError(
  error: VerifyError,
  res: express.Response,
): void {
  if (
    error.code === "auth_time_missing" ||
    error.code === "auth_time_too_old"
  ) {
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `AgentAuth error="login_required", max_age="${config.idJagMaxAuthAgeSeconds}", error_description="${escapeHeader(error.message)}"`,
      )
      .json({
        error: "login_required",
        error_description: error.message,
        max_age: config.idJagMaxAuthAgeSeconds,
      });
    return;
  }
  res.status(400).json({ error: error.code, message: error.message });
}

function escapeHeader(s: string): string {
  return s.replace(/[\\"]/g, "\\$&");
}

async function handleServiceAuth(
  body: { login_hint: string },
  res: express.Response,
): Promise<void> {
  const login_hint = classifyLoginHint(body.login_hint);
  if (!login_hint) {
    res.status(400).json({
      error: "invalid_login_hint",
      message:
        "login_hint must be a recognizable identifier (e.g. an email address).",
    });
    return;
  }

  const {
    registration,
    claimTokenPlaintext,
    claimViewTokenPlaintext,
    userCode,
    userCodeExpiresAt,
  } = createServiceAuthRegistration({ login_hint });

  console.log(
    `[agent-auth] service_auth registration=${registration.id} login_hint=${login_hint.value}`,
  );

  res.json({
    registration_id: registration.id,
    registration_type: "service_auth",
    claim_url: `${config.baseUrl}${config.claimEndpointPath}`,
    claim_token: claimTokenPlaintext,
    claim_token_expires: registration.claim!.expires_at.toISOString(),
    post_claim_scopes: config.postClaimScopes,
    claim: buildCeremonyBlock({
      claimViewTokenPlaintext,
      userCode,
      userCodeExpiresAt,
    }),
  });
}

/*
 * Initiates or re-mints a claim ceremony. Two registration kinds reach here:
 *   - anonymous: first initiation (binds the email) or refresh (after the
 *     user_code window closed before the user could complete).
 *   - service_auth: refresh only (the initial ceremony was minted at
 *     /agent/identity); the supplied email must match the registration.
 */
agentAuthRouter.post(config.claimEndpointPath, async (req, res) => {
  const parsed = parseBody(claimBody, req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_request", message: parsed.message });
    return;
  }
  const registration = findRegistrationByClaimHash(
    sha256Hex(parsed.value.claim_token),
  );
  if (!registration) {
    res.status(401).json({
      error: "invalid_claim_token",
      message: "The claim token is invalid.",
    });
    return;
  }
  if (registration.status === "expired") {
    res
      .status(410)
      .json({ error: "claim_expired", message: "Registration has expired." });
    return;
  }
  if (registration.status === "claimed") {
    res.status(409).json({
      error: "claimed_or_in_flight",
      message: "This registration has already been claimed.",
    });
    return;
  }
  /*
   * Mint a fresh ceremony (new claim_attempt_token + new user_code). The
   * login_hint is per-attempt — a re-initiation may supply a corrected
   * email; only the current attempt's view_token and user_code work, and
   * the /claim page surfaces the current attempt's hint as an advisory.
   */
  const fresh = recordClaimAttempt(registration, {
    kind: "email",
    value: parsed.value.email,
  });
  const attempt = registration.claim!.attempt!;

  console.log(
    `[agent-auth] claim initiated for registration=${registration.id} to=${parsed.value.email}`,
  );

  res.json({
    registration_id: registration.id,
    claim_attempt_id: attempt.id,
    status: "initiated",
    expires_at: attempt.view_expires_at.toISOString(),
    claim_attempt: buildCeremonyBlock({
      claimViewTokenPlaintext: fresh.claimViewTokenPlaintext,
      userCode: fresh.userCode,
      userCodeExpiresAt: fresh.userCodeExpiresAt,
    }),
  });
});

/*
 * Polling moved to /oauth2/token with grant_type=urn:workos:agent-auth:
 * grant-type:claim. The agent posts its claim_token there; while pending
 * the response is { error: "authorization_pending" }, on completion the
 * standard token response is returned plus an `identity_assertion`
 * extension so the agent has a refresh path via jwt-bearer. See
 * routes/token.ts.
 */

function buildCeremonyBlock(input: {
  claimViewTokenPlaintext: string;
  userCode: string;
  userCodeExpiresAt: Date;
}): Record<string, unknown> {
  return {
    user_code: input.userCode,
    expires_in: secondsUntil(input.userCodeExpiresAt),
    verification_uri: buildVerificationUri(input.claimViewTokenPlaintext),
    interval: config.pollIntervalSeconds,
  };
}

/*
 * Routes the user through /login first (mock IdP). `return_to` carries the
 * /claim path with the binding token. The agent never resolves this URL —
 * the user opens it in their browser.
 */
function buildVerificationUri(claimAttemptToken: string): string {
  const claimPath = `/claim?claim_attempt_token=${encodeURIComponent(claimAttemptToken)}`;
  return `${config.baseUrl}/login?return_to=${encodeURIComponent(claimPath)}`;
}

function secondsUntil(when: Date): number {
  return Math.max(0, Math.floor((when.getTime() - Date.now()) / 1000));
}

/*
 * RFC 8935 SET receiver. Providers POST a signed Security Event Token
 * (RFC 8417) here to invalidate the registration and credentials tied to
 * the (iss, sub, aud) triple in the SET. Response shape follows RFC 8935
 * §2.4 — 202 Accepted with no body on success; 400 with { err, description }
 * on failure (note: "err"/"description", not "error"/"message").
 */
agentAuthRouter.post(
  config.eventsEndpointPath,
  express.text({ type: "application/secevent+jwt" }),
  async (req, res) => {
    const token = typeof req.body === "string" ? req.body.trim() : "";
    if (!token) {
      res.status(400).json({
        err: "invalid_request",
        description:
          "Expected JWT body with Content-Type application/secevent+jwt.",
      });
      return;
    }
    const verified = await verifySecEventJwt(token);
    if (!verified.ok) {
      const { err, description } = mapSecEventError(verified.error);
      res.status(400).json({ err, description });
      return;
    }
    /*
     * Dispatch on the SET's `events` schema URIs. We only handle the
     * identity-assertion revocation event today; per RFC 8417 §2.2, any
     * unknown schemas in the same envelope are silently ignored (we still
     * 202 the delivery — the SET was well-formed, we just had nothing to
     * do for it).
     */
    const schemas = Object.keys(verified.claims.events);
    if (schemas.includes(IDENTITY_ASSERTION_REVOKED_SCHEMA)) {
      const revoked = revokeForDelegation(
        verified.claims.iss,
        verified.claims.sub,
        verified.claims.aud,
      );
      console.log(
        `[agent-auth] revoked ${revoked.credentials} credentials and ${revoked.registrations} registration(s) for iss=${verified.claims.iss} sub=${verified.claims.sub} aud=${verified.claims.aud}`,
      );
    } else {
      console.log(
        `[agent-auth] SET from ${verified.claims.iss} carried no recognized events (${schemas.join(", ")}); no-op`,
      );
    }
    res.status(202).end();
  },
);

export const IDENTITY_ASSERTION_REVOKED_SCHEMA =
  "https://schemas.workos.com/events/agent/auth/identity/assertion/revoked";

/**
 * Map our internal verify error codes onto the SET delivery error codes
 * defined in RFC 8935 §2.4: invalid_request, invalid_key, invalid_issuer,
 * invalid_audience, authentication_failed.
 */
function mapSecEventError(error: VerifyError): {
  err: string;
  description: string;
} {
  switch (error.code) {
    case "invalid_issuer":
      return { err: "invalid_issuer", description: error.message };
    case "invalid_audience":
      return { err: "invalid_audience", description: error.message };
    case "invalid_signature":
    case "expired":
      return { err: "authentication_failed", description: error.message };
    default:
      return { err: "invalid_request", description: error.message };
  }
}
