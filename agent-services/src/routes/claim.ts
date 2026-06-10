import type { Request, Response } from "express";
import { Router } from "express";
import { config } from "../config.js";
import { claimFormBody, parseBody } from "../schemas.js";
import {
  type LoginHint,
  type Registration,
  type User,
  completeClaim,
  delegations,
  findRegistrationByClaimViewHash,
  registrations,
  sha256Hex,
  users,
} from "../store.js";
import { trustedIssuerDisplayName } from "../trust.js";

/*
 * User-facing claim form. Cookie-gated by /login. The agent never reaches
 * this code — it polls /oauth2/token with
 * grant_type=urn:workos:agent-auth:grant-type:claim for the resulting status.
 *
 * The query parameter `claim_attempt_token` (an extension to RFC 8628's
 * verification URL) identifies which registration this page is for, without
 * leaking the user-typed `user_code` into link previews or browser history.
 */

export const claimRouter = Router();

const completeUrl = `${config.claimEndpointPath}/complete`;

claimRouter.get("/claim", (req, res) => {
  const token =
    typeof req.query.claim_attempt_token === "string"
      ? req.query.claim_attempt_token
      : "";
  const user = requireUser(req, res, returnToFor(token));
  if (!user) return;

  const registration = lookupRegistration(token);
  if (!registration) {
    return renderMessage(res, 404, "error", "Link invalid", invalidLinkCopy);
  }
  if (registration.status === "claimed") {
    return renderMessage(res, 200, "done", "Already claimed", alreadyClaimedCopy);
  }
  const attempt = registration.claim?.attempt;
  if (!attempt || attempt.view_expires_at.getTime() < Date.now()) {
    return renderMessage(res, 410, "error", "Link expired", expiredLinkCopy);
  }
  if (hintMismatch(attempt.login_hint, user)) {
    return renderWrongAccount(res, attempt.login_hint!, user);
  }

  res.render("claim", {
    variant: "form",
    title: titleFor(registration),
    provider: providerFor(registration),
    userEmail: user.email,
    completeUrl,
    claimAttemptToken: token,
    formError: null,
    advisories: computeAdvisories(registration, user).map(renderAdvisory),
  });
});

/*
 * Form-action endpoint. Same path the agent used to call in the old flow,
 * but the body and auth context are different: cookie-gated, with the user
 * supplying the user_code they got from the agent.
 */
claimRouter.post(completeUrl, (req, res) => {
  const parsed = parseBody(claimFormBody, req.body);
  if (!parsed.ok) {
    return renderMessage(res, 400, "error", "Invalid submission", parsed.message);
  }

  const user = requireUser(
    req,
    res,
    returnToFor(parsed.value.claim_attempt_token),
  );
  if (!user) return;

  const registration = lookupRegistration(parsed.value.claim_attempt_token);
  if (!registration) {
    return renderMessage(
      res,
      404,
      "error",
      "Link invalid",
      "This claim link is no longer valid. Ask the agent to start a new claim.",
    );
  }

  const hint = registration.claim?.attempt?.login_hint;
  if (hintMismatch(hint, user)) {
    return renderWrongAccount(res, hint!, user);
  }

  const result = completeClaim(registration, parsed.value.user_code, user);
  if (!result.ok) {
    res.status(statusForError(result.error)).render("claim", {
      variant: "form-error",
      title: titleFor(registration),
      provider: providerFor(registration),
      userEmail: user.email,
      completeUrl,
      claimAttemptToken: parsed.value.claim_attempt_token,
      formError: humanError(result.error),
      advisories: computeAdvisories(registration, user).map(renderAdvisory),
    });
    return;
  }

  console.log(
    `[claim] registration=${result.registration.id} claimed by user=${user.id}`,
  );

  renderMessage(
    res,
    200,
    "done",
    "All set",
    "The agent has been authorized to act on your behalf. You can close this tab — the agent will pick up automatically.",
  );
});

/*
 * Advisories surface above the form. They don't block — typing the code is
 * still the confirm action — but each one names a thing the user should
 * notice before authorizing: the first time any agent is being linked to
 * this account, or the first time a particular provider (ID-JAG iss) is
 * being linked.
 *
 * Wrong-account is *not* an advisory: a login_hint that doesn't match the
 * signed-in user is a hard reject upstream of this function — the form
 * never renders in that case. Provider name comes from the service's trust
 * list, never from anything the provider supplies in the ID-JAG.
 */
type Advisory =
  | { kind: "first_time_account"; userEmail: string }
  | { kind: "first_time_provider"; providerName: string; userEmail: string };

function computeAdvisories(
  registration: Registration,
  user: User,
): Advisory[] {
  const out: Advisory[] = [];

  if (registration.kind === "id_jag" && registration.id_jag) {
    const iss = registration.id_jag.iss;
    let providerLinked = false;
    for (const d of delegations.values()) {
      if (d.iss === iss && d.user_id === user.id) {
        providerLinked = true;
        break;
      }
    }
    if (!providerLinked) {
      out.push({
        kind: "first_time_provider",
        providerName: trustedIssuerDisplayName(iss),
        userEmail: user.email,
      });
    }
  }

  let anyPriorClaim = false;
  for (const r of registrations.values()) {
    if (r.user_id === user.id && r.claimed_at && r.id !== registration.id) {
      anyPriorClaim = true;
      break;
    }
  }
  if (!anyPriorClaim) {
    out.push({ kind: "first_time_account", userEmail: user.email });
  }

  return out;
}

function renderAdvisory(a: Advisory): string {
  switch (a.kind) {
    case "first_time_provider":
      return `<strong>${escapeHtml(a.providerName)}</strong> has never been linked to <code>${escapeHtml(a.userEmail)}</code> before. Authorizing here lets agents running on ${escapeHtml(a.providerName)} act on your behalf at this service in the future.`;
    case "first_time_account":
      return `This is the first agent being linked to <code>${escapeHtml(a.userEmail)}</code>.`;
  }
}

function hintMismatch(
  hint: LoginHint | undefined,
  user: User,
): boolean {
  return (
    hint?.kind === "email" &&
    hint.value.toLowerCase() !== user.email.toLowerCase()
  );
}

function renderMessage(
  res: Response,
  status: number,
  variant: "done" | "error",
  title: string,
  message: string,
): void {
  res.status(status).render("claim", { variant, title, message });
}

function renderWrongAccount(
  res: Response,
  hint: LoginHint,
  user: User,
): void {
  res.status(403).render("claim", {
    variant: "wrong-account",
    title: "Wrong account",
    claimEmail: hint.value,
    userEmail: user.email,
  });
}

/**
 * Title for the claim form. ID-JAG step-up registrations name the provider
 * being linked ("Link Cursor to your account?"); anonymous and service_auth
 * use generic copy. Provider name comes from the service's trust list (in
 * production this would typically resolve via CIMD with the service still
 * gating which client_name values it renders).
 */
function titleFor(registration: Registration): string {
  const provider = providerFor(registration);
  return provider
    ? `Link ${provider} to your account?`
    : "Authorize this agent?";
}

function providerFor(registration: Registration): string | null {
  if (registration.kind === "id_jag" && registration.id_jag) {
    return trustedIssuerDisplayName(registration.id_jag.iss);
  }
  return null;
}

function requireUser(
  req: Request,
  res: Response,
  returnTo: string,
): User | undefined {
  const user = req.session.userId ? users.get(req.session.userId) : undefined;
  if (!user) {
    res.redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
    return undefined;
  }
  return user;
}

function lookupRegistration(token: string): Registration | undefined {
  if (!token) return undefined;
  return findRegistrationByClaimViewHash(sha256Hex(token));
}

function returnToFor(token: string): string {
  return `/claim?claim_attempt_token=${encodeURIComponent(token)}`;
}

function statusForError(error: string): number {
  switch (error) {
    case "user_code_invalid":
      return 401;
    case "user_code_expired":
    case "claim_expired":
      return 410;
    case "previously_claimed":
      return 409;
    default:
      return 400;
  }
}

function humanError(error: string): string {
  switch (error) {
    case "user_code_invalid":
      return "That code doesn't match. Check the digits and try again.";
    case "user_code_expired":
      return "That code has expired. Ask the agent for a fresh code.";
    case "claim_expired":
      return "This claim has expired. Ask the agent to start a new one.";
    case "previously_claimed":
      return "This registration has already been claimed.";
    default:
      return error;
  }
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

const invalidLinkCopy =
  "This claim link is no longer valid — it may have been superseded, used, or expired. Ask the agent to start a new claim.";
const alreadyClaimedCopy =
  "This registration has already been claimed. You can close this tab.";
const expiredLinkCopy =
  "This claim link has expired. Ask the agent to start a new claim.";
