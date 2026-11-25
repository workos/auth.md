import express, { Router } from "express";
import { config } from "../config.js";
import { matchOrProvision } from "../matcher.js";
import {
  agentAuthBody,
  claimBody,
  claimCompleteBody,
  parseBody,
} from "../schemas.js";
import {
  type Registration,
  classifyLoginHint,
  completeClaimByAgent,
  createAnonymousRegistration,
  createServiceAuthRegistration,
  findOrCreateIdJagRegistration,
  findRegistrationByClaimHash,
  mintRefreshToken,
  recordClaimAttempt,
  revokeForDelegation,
  rotateRefreshToken,
  sha256Hex,
  users,
} from "../store.js";
import {
  type IdJagClaims,
  type VerifyError,
  signServiceIdJag,
  verifyIdJag,
  verifySecEventJwt,
} from "../verify.js";

/*
 * Agent-facing endpoints. The user-facing claim page — where the human signs
 * in, confirms, and reads back the user_code the page reveals — lives in
 * routes/login.ts and routes/claim.ts. The agent never reaches those; it
 * completes the ceremony by submitting that code at claim/complete.
 *
 * Three response shapes from POST /agent/identity for ID-JAG flows:
 *   - clean match → 200 with an identity assertion
 *   - step-up required → 401 interaction_required with a claim block
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
  if (parsed.value.type === "refresh") {
    return handleRefresh(parsed.value, res);
  }

  const { registration, claimTokenPlaintext } = createAnonymousRegistration();
  const { jwt, expiresAt } = await signServiceIdJag({ registration });
  console.log(
    `[agent-auth] registered anonymous agent registration=${registration.id}`,
  );
  res.json({
    id: registration.id,
    type: "anonymous",
    identity: { assertion: jwt, expires_at: expiresAt.toISOString() },
    scopes: {
      pre_claim: config.preClaimScopes,
      post_claim: config.postClaimScopes,
    },
    claim: {
      token: claimTokenPlaintext,
      expires_at: registration.claim!.expires_at.toISOString(),
      url: `${config.baseUrl}${config.claimEndpointPath}`,
    },
  });
});

/**
 * Exchanges a rotating refresh token for a fresh identity assertion (and a
 * new refresh token). Only service_auth and claimed registrations hold one.
 */
async function handleRefresh(
  body: { refresh_token: string },
  res: express.Response,
): Promise<void> {
  const rotated = rotateRefreshToken(body.refresh_token);
  if (!rotated.ok) {
    res.status(400).json({
      error: "invalid_refresh_token",
      message: "The refresh token is invalid, expired, or already used.",
    });
    return;
  }
  const user = rotated.registration.user_id
    ? users.get(rotated.registration.user_id)
    : undefined;
  const { jwt, expiresAt } = await signServiceIdJag({
    registration: rotated.registration,
    email: user?.email,
    emailVerified: user?.email_verified,
  });
  console.log(
    `[agent-auth] refreshed identity assertion for registration=${rotated.registration.id}`,
  );
  res.json({
    id: rotated.registration.id,
    type: "refresh",
    identity: {
      assertion: jwt,
      expires_at: expiresAt.toISOString(),
      refresh_token: {
        value: rotated.value,
        expires_at: rotated.expiresAt.toISOString(),
      },
    },
  });
}

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
    `[agent-auth] issued identity assertion to user=${registration.user_id} via iss=${claims.iss} sub=${claims.sub} registration=${registration.id}`,
  );
  res.json({
    id: registration.id,
    type: "identity_assertion",
    identity: { assertion: jwt, expires_at: expiresAt.toISOString() },
    scopes: config.scopesSupported,
  });
}

/**
 * Step-up: the ID-JAG matched an existing account by email/phone but no
 * (iss, sub) delegation exists. Mint the ceremony and return a 401 with
 * the OIDC-vocabulary `interaction_required` error so the agent knows to
 * surface the verification_uri to the user. The user signs in at the
 * service, sees a provider-aware confirmation page, and confirms; the page
 * reveals the user_code for them to read back, and the agent submits it at
 * claim/complete to bind the delegation.
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
        "This ID-JAG matches an existing account. Hand the verification_uri to the user; they confirm and read back a user_code for you to submit at claim/complete.",
      id: result.registration.id,
      type: "identity_assertion",
      scopes: { post_claim: config.scopesSupported },
      claim: buildClaimBlock(
        result.registration,
        result.claimTokenPlaintext,
        result.claimViewTokenPlaintext,
      ),
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

  const { registration, claimTokenPlaintext, claimViewTokenPlaintext } =
    createServiceAuthRegistration({ login_hint });

  console.log(
    `[agent-auth] service_auth registration=${registration.id} login_hint=${login_hint.value}`,
  );

  res.json({
    id: registration.id,
    type: "service_auth",
    scopes: { post_claim: config.postClaimScopes },
    claim: buildClaimBlock(
      registration,
      claimTokenPlaintext,
      claimViewTokenPlaintext,
    ),
  });
}

/*
 * Starts (or re-mints) a claim attempt. `type` is always service_auth — the
 * claim method — even for anonymous registrations. Two registration kinds
 * reach here:
 *   - anonymous: first initiation (binds the email) or a re-mint after the
 *     user_code window closed before the user could complete.
 *   - service_auth: re-mint only (the initial attempt was minted at
 *     /agent/identity); the supplied login_hint may correct the email.
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
      error: "already_claimed",
      message: "This registration has already been claimed.",
    });
    return;
  }
  /*
   * Mint a fresh attempt (new claim_attempt_token + new user_code). The
   * login_hint is per-attempt — a re-initiation may supply a corrected
   * email; only the current attempt's view_token and user_code work, and
   * the /claim page surfaces the current attempt's hint as an advisory.
   */
  const fresh = recordClaimAttempt(registration, {
    kind: "email",
    value: parsed.value.login_hint,
  });

  console.log(
    `[agent-auth] claim attempt started for registration=${registration.id} to=${parsed.value.login_hint}`,
  );

  res.json({
    id: registration.id,
    type: "service_auth",
    attempt: buildAttemptBlock(registration, fresh.claimViewTokenPlaintext),
  });
});

/*
 * Agent-facing claim completion. The agent submits its claim_token plus the
 * user_code the human read off the claim page. On success it collects the
 * post-claim identity — a service-signed assertion plus a rotating refresh
 * token — as a one-shot response. The user-facing confirmation happens
 * separately, on the /claim page (routes/claim.ts).
 */
agentAuthRouter.post(
  `${config.claimEndpointPath}/complete`,
  async (req, res) => {
    const parsed = parseBody(claimCompleteBody, req.body);
    if (!parsed.ok) {
      res
        .status(400)
        .json({ error: "invalid_request", message: parsed.message });
      return;
    }
    const registration = findRegistrationByClaimHash(
      sha256Hex(parsed.value.claim_token),
    );
    if (!registration) {
      res.status(400).json({
        error: "invalid_claim",
        message: "The claim attempt is invalid.",
      });
      return;
    }

    const result = completeClaimByAgent(registration, parsed.value.user_code);
    if (!result.ok) {
      const { status, error, message } = completeErrorResponse(result.error);
      res.status(status).json({ error, message });
      return;
    }

    const { jwt, expiresAt } = await signServiceIdJag({
      registration: result.registration,
      email: result.user.email,
      emailVerified: result.user.email_verified,
    });
    const refreshToken = mintRefreshToken(result.registration.id);

    console.log(
      `[agent-auth] claim completed for registration=${result.registration.id} by user=${result.user.id}`,
    );

    res.json({
      id: result.registration.id,
      status: result.registration.status,
      identity: {
        assertion: jwt,
        expires_at: expiresAt.toISOString(),
        refresh_token: {
          value: refreshToken.value,
          expires_at: refreshToken.expiresAt.toISOString(),
        },
      },
    });
  },
);

function completeErrorResponse(
  error:
    | "not_confirmed"
    | "user_code_invalid"
    | "user_code_expired"
    | "previously_claimed"
    | "claim_expired",
): { status: number; error: string; message: string } {
  switch (error) {
    case "not_confirmed":
      return {
        status: 409,
        error: "claim_not_confirmed",
        message:
          "The user hasn't confirmed on the verification page yet. Wait and retry.",
      };
    case "user_code_invalid":
      return {
        status: 401,
        error: "invalid_user_code",
        message: "The user_code is invalid. Ask the user to read it again.",
      };
    case "user_code_expired":
      return {
        status: 410,
        error: "user_code_expired",
        message:
          "The user_code has expired. Start a new attempt at the claim endpoint.",
      };
    case "previously_claimed":
      return {
        status: 409,
        error: "already_claimed",
        message: "This registration has already been claimed.",
      };
    case "claim_expired":
      return {
        status: 410,
        error: "claim_expired",
        message: "The claim has expired. Re-register.",
      };
  }
}

/*
 * The claim block returned with a registration: the agent's claim token,
 * the window, the claim endpoint URL, and the first attempt's user-facing
 * verification_uri. The user_code is never here — it's revealed on the
 * claim page for the user to read back.
 */
function buildClaimBlock(
  registration: Registration,
  claimTokenPlaintext: string,
  viewToken: string,
): Record<string, unknown> {
  return {
    token: claimTokenPlaintext,
    expires_at: registration.claim!.expires_at.toISOString(),
    url: `${config.baseUrl}${config.claimEndpointPath}`,
    attempt: buildAttemptBlock(registration, viewToken),
  };
}

/*
 * The user-facing attempt block: the verification_uri (with the view token
 * embedded) and its window. The user_code is never here.
 */
function buildAttemptBlock(
  registration: Registration,
  viewToken: string,
): Record<string, unknown> {
  const attempt = registration.claim!.attempt!;
  return {
    verification_uri: buildVerificationUri(viewToken),
    expires_at: attempt.view_expires_at.toISOString(),
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
