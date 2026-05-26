import express, { Router } from "express";
import { config } from "../config.js";
import { sendClaimViewEmail } from "../mail.js";
import { matchOrProvision } from "../matcher.js";
import {
  ASSERTION_TYPES,
  agentAuthBody,
  claimBody,
  claimCompleteBody,
  generateOtpBody,
  parseBody,
} from "../schemas.js";
import {
  type Registration,
  completeClaim,
  createAnonymousRegistration,
  createEmailVerificationRegistration,
  createIdJagRegistration,
  credentials,
  findOrCreateIdJagRegistration,
  findRegistrationByClaimHash,
  findRegistrationByClaimViewHash,
  generateOtpForRegistration,
  recordAnonymousClaimAttempt,
  revokeForDelegation,
  sha256Hex,
} from "../store.js";
import { type SetClaims, signServiceIdJag, verifyIdJag, verifySet } from "../verify.js";

// Agent-facing endpoints implementing the OTP-exchange flavor of the
// agent-auth spec. The user-facing /agent/register/claim/view endpoint at the
// bottom of this file is also part of the spec — it's where the email link
// lands and where the OTP is rendered.

export const agentAuthRouter = Router();

agentAuthRouter.post(config.registrationEndpointPath, async (req, res) => {
  const parsed = parseBody(agentAuthBody, req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_request", message: parsed.message });
    return;
  }

  if (parsed.value.type === "identity_assertion") {
    if (parsed.value.assertion_type === ASSERTION_TYPES.EMAIL_ASSERTION) {
      return handleEmailAssertion(parsed.value, res);
    }
    return handleIdJagAssertion(parsed.value, res);
  }

  // type === "anonymous"
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
    res
      .status(400)
      .json({ error: verified.error.code, message: verified.error.message });
    return;
  }
  const { claims } = verified;
  const matchResult = matchOrProvision(claims);

  if (matchResult.kind === "step_up_required") {
    // First-time (iss, sub) matched an existing user by email or phone. Don't
    // bind the delegation yet — initiate the OTP claim ceremony so the user
    // proves ownership. The matched user already has an email on file; for
    // phone-match we send the OTP there too since this demo has no SMS.
    const recipient = matchResult.matched_user.email;
    const { registration, claimTokenPlaintext, claimViewTokenPlaintext } =
      createIdJagRegistration({
        iss: claims.iss,
        sub: claims.sub,
        aud: claims.aud,
        email: recipient,
      });
    const viewUrl = `${config.baseUrl}${config.claimEndpointPath}/view?token=${encodeURIComponent(claimViewTokenPlaintext)}`;
    await sendClaimViewEmail({
      registrationId: registration.id,
      recipientEmail: recipient,
      viewUrl,
      expiresAt: registration.claim!.attempt!.view_expires_at,
    });
    console.log(
      `[agent-auth] step-up required for iss=${claims.iss} sub=${claims.sub} via=${matchResult.via}; registration=${registration.id}`,
    );
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `AgentAuth error="interaction_required", error_description="ID-JAG matches existing account; OTP confirmation required"`,
      )
      .json({
        error: "interaction_required",
        message:
          matchResult.via === "email"
            ? "This ID-JAG matches an existing account by email. Confirm ownership by completing the OTP claim flow."
            : "This ID-JAG matches an existing account by phone number. Confirm ownership by completing the OTP claim flow.",
        registration_id: registration.id,
        registration_type: "id-jag-step-up",
        claim_url: `${config.baseUrl}${config.claimEndpointPath}`,
        claim_token: claimTokenPlaintext,
        claim_token_expires: registration.claim!.expires_at.toISOString(),
        post_claim_scopes: config.scopesSupported,
      });
    return;
  }

  const { user } = matchResult;
  const scope = config.scopesSupported;

  // Clean ID-JAG match: ensure a registration exists for this (iss, sub, aud)
  // so future credential lifecycle (revocation, audit, /token refresh) has a
  // durable identity to anchor to. Idempotent across repeat presentations.
  const registration = findOrCreateIdJagRegistration({
    iss: claims.iss,
    sub: claims.sub,
    aud: claims.aud,
    userId: user.id,
  });

  const { jwt, expiresAt } = await signServiceIdJag({
    registration,
    email: claims.email,
    emailVerified: claims.email_verified,
    amr: claims.amr,
  });
  console.log(
    `[agent-auth] issued identity_assertion to user=${user.id} via iss=${claims.iss} sub=${claims.sub} registration=${registration.id}`,
  );
  res.json({
    registration_id: registration.id,
    registration_type: "agent-provider",
    identity_assertion: jwt,
    assertion_expires: expiresAt.toISOString(),
    scopes: scope,
  });
}

async function handleEmailAssertion(
  body: { assertion: string },
  res: express.Response,
): Promise<void> {
  const { registration, claimTokenPlaintext, claimViewTokenPlaintext } =
    createEmailVerificationRegistration({ email: body.assertion });

  // Email-verification registrations bundle the claim ceremony — we send
  // the OTP-view email immediately. The agent skips /agent/register/claim and
  // polls /complete with the OTP the user reads back.
  const viewUrl = `${config.baseUrl}${config.claimEndpointPath}/view?token=${encodeURIComponent(claimViewTokenPlaintext)}`;
  await sendClaimViewEmail({
    registrationId: registration.id,
    recipientEmail: body.assertion,
    viewUrl,
    expiresAt: registration.claim!.attempt!.view_expires_at,
  });

  console.log(
    `[agent-auth] email-verification registration=${registration.id} email=${body.assertion}`,
  );

  res.json({
    registration_id: registration.id,
    registration_type: "email-verification",
    claim_url: `${config.baseUrl}${config.claimEndpointPath}`,
    claim_token: claimTokenPlaintext,
    claim_token_expires: registration.claim!.expires_at.toISOString(),
    post_claim_scopes: config.postClaimScopes,
  });
}

// Anonymous-only entry point. Email-verification registrations skip this —
// their claim attempt is created in /agent/register itself.
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
  if (registration.kind !== "anonymous") {
    res.status(409).json({
      error: "claimed_or_in_flight",
      message:
        "Email-verification registrations do not require an explicit /claim call.",
    });
    return;
  }
  if (registration.status === "expired") {
    // Sweep credentials bound to this expired registration. No background
    // job — we GC on the next interaction with the claim handle.
    for (const cred of credentials.values()) {
      if (cred.registration_id === registration.id && !cred.revoked) {
        cred.revoked = true;
      }
    }
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

  // Idempotent: if a claim attempt is already in flight (same email, view
  // window still open), echo current state without resending the email. A
  // same-email retry after the view window expires falls through and mints
  // a fresh attempt below.
  const inflight = registration.claim?.attempt;
  if (
    registration.status === "pending_claim" &&
    registration.claim?.email === parsed.value.email &&
    inflight &&
    inflight.view_expires_at.getTime() > Date.now()
  ) {
    res.json({
      registration_id: registration.id,
      claim_attempt_id: inflight.id,
      status: "initiated",
      expires_at: inflight.view_expires_at.toISOString(),
    });
    return;
  }

  const claimViewTokenPlaintext = recordAnonymousClaimAttempt(
    registration,
    parsed.value.email,
  );
  const attempt = registration.claim!.attempt!;
  const viewUrl = `${config.baseUrl}${config.claimEndpointPath}/view?token=${encodeURIComponent(claimViewTokenPlaintext)}`;
  await sendClaimViewEmail({
    registrationId: registration.id,
    recipientEmail: parsed.value.email,
    viewUrl,
    expiresAt: attempt.view_expires_at,
  });

  console.log(
    `[agent-auth] claim initiated for registration=${registration.id} to=${parsed.value.email}`,
  );

  res.json({
    registration_id: registration.id,
    claim_attempt_id: attempt.id,
    status: "initiated",
    expires_at: attempt.view_expires_at.toISOString(),
  });
});

// Exchanges a claim_attempt_token for an OTP.
agentAuthRouter.post(`${config.claimEndpointPath}/attempt/challenge`, (req, res) => {
  const parsed = parseBody(generateOtpBody, req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_request", message: parsed.message });
    return;
  }
  const registration = findRegistrationByClaimViewHash(
    sha256Hex(parsed.value.claim_attempt_token),
  );
  if (!registration) {
    res.status(410).json({
      error: "claim_superseded",
      message: "The claim attempt token is invalid or has been superseded.",
    });
    return;
  }
  if (registration.status === "claimed") {
    res
      .status(409)
      .json({ error: "claim_completed", message: "Already claimed." });
    return;
  }
  const viewExpires = registration.claim?.attempt?.view_expires_at;
  if (!viewExpires || viewExpires.getTime() < Date.now()) {
    res
      .status(410)
      .json({ error: "claim_expired", message: "Claim window has closed." });
    return;
  }
  const { otp, expiresAt } = generateOtpForRegistration(registration);
  console.log(`[agent-auth] generated otp for registration=${registration.id}`);
  res.json({
    type: "otp",
    challenge: otp,
    expires_at: expiresAt.toISOString(),
  });
});

agentAuthRouter.post(`${config.claimEndpointPath}/complete`, async (req, res) => {
  const parsed = parseBody(claimCompleteBody, req.body);
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

  const result = completeClaim(registration, parsed.value.otp);
  if (!result.ok) {
    const status = pickStatusForCompleteError(result.error);
    res
      .status(status)
      .json({ error: result.error, message: humanCompleteError(result.error) });
    return;
  }

  console.log(
    `[agent-auth] claim completed for registration=${result.registration.id}`,
  );

  res.json(await buildCompleteResponse(result.registration));
});

function pickStatusForCompleteError(error: string): number {
  switch (error) {
    case "otp_invalid":
      return 401;
    case "otp_not_generated":
      return 400;
    case "otp_expired":
    case "claim_expired":
      return 410;
    case "previously_claimed":
      return 409;
    default:
      return 400;
  }
}

function humanCompleteError(error: string): string {
  switch (error) {
    case "otp_invalid":
      return "The provided OTP does not match the claim attempt.";
    case "otp_not_generated":
      return "No OTP has been generated for this claim. Open the email link first.";
    case "otp_expired":
      return "The OTP's exchange window has passed.";
    case "claim_expired":
      return "This registration has expired and cannot be claimed.";
    case "previously_claimed":
      return "This registration has already been claimed.";
    default:
      return error;
  }
}

async function buildCompleteResponse(
  registration: Registration,
): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    registration_id: registration.id,
    status: "claimed",
  };
  // Email-verification and id_jag registrations get a fresh identity_assertion
  // at /complete to use at /token. Anonymous registrations don't need one
  // here — they received it from /agent/register at registration time and any
  // credentials minted from it get an in-place scope upgrade.
  if (
    registration.kind === "email_verification" ||
    registration.kind === "id_jag"
  ) {
    const { jwt, expiresAt } = await signServiceIdJag({
      registration,
      email: registration.claim?.email,
      emailVerified: registration.claim?.email ? true : undefined,
    });
    base.identity_assertion = jwt;
    base.assertion_expires = expiresAt.toISOString();
  }
  return base;
}

// User-facing OTP-view page. The email link lands here; the page gates
// OTP minting behind an explicit user click that POSTs to
// /agent/register/claim/attempt/challenge. In production this page is typically
// gated by a user session to handle edge cases (like updating the email on
// the claim) upfront instead of in the agent context.
agentAuthRouter.get(`${config.claimEndpointPath}/view`, async (req, res) => {
  const rawToken = req.query.token;
  const token = typeof rawToken === "string" ? rawToken : "";
  if (!token) {
    res
      .status(400)
      .type("html")
      .send(
        renderClaimViewPage({
          ok: false,
          title: "Missing token",
          message: "This link is missing a claim view token.",
        }),
      );
    return;
  }
  const registration = findRegistrationByClaimViewHash(sha256Hex(token));
  if (!registration) {
    res
      .status(404)
      .type("html")
      .send(
        renderClaimViewPage({
          ok: false,
          title: "Link invalid",
          message:
            "This link is no longer valid — it may have been superseded, used, or expired.",
        }),
      );
    return;
  }
  if (registration.status === "claimed") {
    res
      .status(200)
      .type("html")
      .send(
        renderClaimViewPage({
          ok: true,
          title: "Already claimed",
          message:
            "This registration has already been claimed. You can close this tab.",
        }),
      );
    return;
  }
  const viewExpires = registration.claim?.attempt?.view_expires_at;
  if (!viewExpires || viewExpires.getTime() < Date.now()) {
    res
      .status(410)
      .type("html")
      .send(
        renderClaimViewPage({
          ok: false,
          title: "Link expired",
          message:
            "This link has expired. Ask the agent to start a new claim to receive a fresh email.",
        }),
      );
    return;
  }
  console.log(
    `[agent-auth] rendered claim-view page for registration=${registration.id}`,
  );
  res
    .status(200)
    .type("html")
    .send(
      renderClaimViewPage({
        ok: true,
        title: "Read this code back to the agent",
        message: `The agent will ask you for a one-time code to confirm you're the owner of <code>${escapeHtml(registration.claim?.email ?? "")}</code>. Read the code below back to the agent — do not share it with anyone else.`,
        claimAttemptToken: token,
      }),
    );
});

function renderClaimViewPage(input: {
  ok: boolean;
  title: string;
  message: string;
  claimAttemptToken?: string;
}): string {
  const headingColor = input.ok ? "var(--brand-primary)" : "var(--error)";
  const otpBlock = input.claimAttemptToken
    ? `
<div class="otp-wrap">
  <div id="otp-out" class="otp-loading">Loading…</div>
  <div id="error-out" class="err" hidden></div>
</div>
<script>
(function () {
  var otpOut = document.getElementById("otp-out");
  var errOut = document.getElementById("error-out");
  var token = ${JSON.stringify(input.claimAttemptToken)};
  fetch(${JSON.stringify(`${config.claimEndpointPath}/attempt/challenge`)}, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim_attempt_token: token }),
  })
    .then(function (resp) { return resp.json().then(function (data) { return { ok: resp.ok, data: data }; }); })
    .then(function (r) {
      if (!r.ok) {
        otpOut.hidden = true;
        errOut.textContent = r.data.message || r.data.error || "Could not load code.";
        errOut.hidden = false;
        return;
      }
      otpOut.className = "";
      otpOut.textContent = "";
      var otpDiv = document.createElement("div");
      otpDiv.className = "otp";
      otpDiv.textContent = r.data.challenge;
      var metaDiv = document.createElement("div");
      metaDiv.className = "otp-meta";
      metaDiv.textContent = "Expires " + r.data.expires_at;
      otpOut.appendChild(otpDiv);
      otpOut.appendChild(metaDiv);
    })
    .catch(function () {
      otpOut.hidden = true;
      errOut.textContent = "Network error. Try refreshing the page.";
      errOut.hidden = false;
    });
})();
</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.title)}</title>
<style>
  :root {
    --brand-primary: #6D6DF2;
    --brand-text: #030527;
    --brand-bg: #FFFFFF;
    --error: #e55039;
    --muted: rgba(3, 5, 39, .65);
    --border: rgba(3, 5, 39, .12);
    --surface-soft: rgba(3, 5, 39, .04);
  }
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5; color: var(--brand-text); background: var(--brand-bg); text-align: center; }
  h1 { color: ${headingColor}; }
  p { color: var(--muted); }
  code { background: var(--surface-soft); padding: .05rem .3rem; border-radius: .2rem; font-size: .9em; }
  .otp-wrap { margin: 2rem auto; }
  .otp { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 2.6rem; letter-spacing: .4rem; padding: 1rem 1.5rem; border: 1px solid var(--border); background: var(--surface-soft); border-radius: .5rem; display: inline-block; color: var(--brand-text); }
  .otp-meta { color: var(--muted); font-size: .8rem; margin-top: .5rem; }
  .otp-loading { color: var(--muted); font-size: .9rem; }
  .err { color: var(--error); margin-top: 1rem; font-size: .9rem; }
</style>
</head>
<body>
<h1>${escapeHtml(input.title)}</h1>
<p>${input.message}</p>${otpBlock}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

// SET event-schema dispatch table. Each entry maps a schema URI from the
// SET's `events` claim to a handler that applies the event locally. Unknown
// schemas are tolerated (RFC 8417 §2.2 doesn't require receivers to handle
// every event type).
const SET_EVENT_HANDLERS: Record<string, (claims: SetClaims) => void> = {
  "https://schemas.workos.com/events/agent/auth/identity/assertion/revoked": (
    claims,
  ) => {
    const count = revokeForDelegation(
      claims.iss,
      claims.sub ?? "",
      claims.aud,
    );
    console.log(
      `[event] identity-assertion-revoked: revoked ${count} credentials for iss=${claims.iss} sub=${claims.sub}`,
    );
  },
};

// RFC 8935 push-based SET receiver. Accepts a signed SET (RFC 8417), verifies
// it, and dispatches each entry in the events claim to a registered handler.
agentAuthRouter.post(
  config.eventsEndpointPath,
  express.text({ type: "application/secevent+jwt" }),
  async (req, res) => {
    const token = typeof req.body === "string" ? req.body.trim() : "";
    if (!token) {
      res.status(400).json({
        err: "invalid_request",
        description:
          "Expected SET body with Content-Type application/secevent+jwt.",
      });
      return;
    }
    const verified = await verifySet(token);
    if (!verified.ok) {
      res
        .status(400)
        .json({ err: verified.error.code, description: verified.error.message });
      return;
    }
    for (const schemaUri of Object.keys(verified.claims.events)) {
      const handler = SET_EVENT_HANDLERS[schemaUri];
      if (handler) {
        handler(verified.claims);
      } else {
        console.log(`[event] no handler for ${schemaUri}; ignored`);
      }
    }
    res.sendStatus(202);
  },
);
