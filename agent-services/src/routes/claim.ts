import type { Request, Response } from "express";
import { Router } from "express";
import { config } from "../config.js";
import { claimConfirmFormBody, parseBody } from "../schemas.js";
import {
  type Registration,
  type User,
  confirmClaimView,
  delegations,
  findRegistrationByClaimViewHash,
  registrations,
  sha256Hex,
  users,
} from "../store.js";
import { trustedIssuerDisplayName } from "../trust.js";

/*
 * User-facing claim page. Cookie-gated by /login. The agent never reaches
 * this code — it completes the ceremony by submitting, at claim/complete, the
 * user_code this page reveals to the signed-in human.
 *
 * The query parameter `claim_attempt_token` (an extension to RFC 8628's
 * verification URL) identifies which registration this page is for, without
 * leaking the user_code into link previews or browser history. The user_code
 * itself travels service → user → agent: revealed here, read back by the
 * human, submitted by the agent.
 */

export const claimRouter = Router();

claimRouter.get("/claim", (req, res) => {
  const token =
    typeof req.query.claim_attempt_token === "string"
      ? req.query.claim_attempt_token
      : "";
  const user = requireUser(req, res, returnToFor(token));
  if (!user) return;

  const registration = lookupRegistration(token);
  const gate = gateRegistration(registration, res);
  if (!gate) return;

  if (hintMismatch(gate.claim!.attempt!.login_hint, user)) {
    res
      .status(403)
      .type("html")
      .send(renderWrongAccount(gate.claim!.attempt!.login_hint!));
    return;
  }

  res.type("html").send(
    renderClaimPage({
      status: "form",
      title: "Authorize this agent?",
      message: `You're signed in as <code>${escapeHtml(user.email)}</code>. Authorize this agent to act on your behalf — you'll then get a 6-digit code to read back to it.`,
      advisories: computeAdvisories(gate, user),
      claimAttemptToken: token,
    }),
  );
});

/*
 * Confirmation endpoint. The signed-in human confirms; we bind them to the
 * attempt and reveal the user_code for them to read back to the agent. No
 * code is typed here — it travels service → user → agent.
 */
claimRouter.post("/claim/confirm", (req, res) => {
  const parsed = parseBody(claimConfirmFormBody, req.body);
  if (!parsed.ok) {
    res
      .status(400)
      .type("html")
      .send(
        renderClaimPage({
          status: "error",
          title: "Invalid submission",
          message: parsed.message,
        }),
      );
    return;
  }

  const user = requireUser(
    req,
    res,
    returnToFor(parsed.value.claim_attempt_token),
  );
  if (!user) return;

  const registration = lookupRegistration(parsed.value.claim_attempt_token);
  const gate = gateRegistration(registration, res);
  if (!gate) return;

  const hint = gate.claim!.attempt!.login_hint;
  if (hintMismatch(hint, user)) {
    res.status(403).type("html").send(renderWrongAccount(hint!));
    return;
  }

  const result = confirmClaimView(gate, user);
  if (!result.ok) {
    res
      .status(result.error === "previously_claimed" ? 409 : 410)
      .type("html")
      .send(
        renderClaimPage({
          status: "error",
          title:
            result.error === "previously_claimed"
              ? "Already claimed"
              : "Link expired",
          message:
            result.error === "previously_claimed"
              ? "This registration has already been claimed. You can close this tab."
              : "This claim link has expired. Ask the agent to start a new claim.",
        }),
      );
    return;
  }

  console.log(
    `[claim] registration=${gate.id} confirmed by user=${user.id}; user_code revealed`,
  );

  res
    .status(200)
    .type("html")
    .send(
      renderClaimPage({
        status: "reveal",
        title: "Read this code back to the agent",
        message:
          "Give this 6-digit code to the agent that sent you here. It submits the code to finish — you don't type it anywhere.",
        userCode: result.userCode,
      }),
    );
});

/*
 * Shared gate for both the page and the confirm action: resolves the
 * registration or renders the right terminal HTML (invalid / claimed /
 * expired). Returns the registration only when it's live and has an attempt.
 */
function gateRegistration(
  registration: Registration | undefined,
  res: Response,
): Registration | undefined {
  if (!registration) {
    res
      .status(404)
      .type("html")
      .send(
        renderClaimPage({
          status: "error",
          title: "Link invalid",
          message:
            "This claim link is no longer valid — it may have been superseded, used, or expired. Ask the agent to start a new claim.",
        }),
      );
    return undefined;
  }
  if (registration.status === "claimed") {
    res
      .status(200)
      .type("html")
      .send(
        renderClaimPage({
          status: "done",
          title: "Already claimed",
          message:
            "This registration has already been claimed. You can close this tab.",
        }),
      );
    return undefined;
  }
  const attempt = registration.claim?.attempt;
  if (!attempt || attempt.view_expires_at.getTime() < Date.now()) {
    res
      .status(410)
      .type("html")
      .send(
        renderClaimPage({
          status: "error",
          title: "Link expired",
          message:
            "This claim link has expired. Ask the agent to start a new claim.",
        }),
      );
    return undefined;
  }
  return registration;
}

/*
 * Advisories surface above the confirm button. They don't block — confirming
 * is still the action — but each one names a thing the user should notice
 * before authorizing: the first time any agent is being linked to this
 * account, or the first time a particular provider (ID-JAG iss) is being
 * linked.
 *
 * Wrong-account is *not* an advisory: a login_hint that doesn't match the
 * signed-in user is a hard reject upstream of this function — the page never
 * renders in that case. Provider name comes from the service's trust list,
 * never from anything the provider supplies in the ID-JAG.
 */
type Advisory =
  | { kind: "first_time_account"; userEmail: string }
  | { kind: "first_time_provider"; providerName: string; userEmail: string };

function computeAdvisories(registration: Registration, user: User): Advisory[] {
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
  hint: { kind: "email"; value: string } | undefined,
  user: User,
): boolean {
  return (
    hint?.kind === "email" &&
    hint.value.toLowerCase() !== user.email.toLowerCase()
  );
}

function renderWrongAccount(hint: { kind: "email"; value: string }): string {
  return renderClaimPage({
    status: "error",
    title: "Wrong account",
    message: `This claim was started for <code>${escapeHtml(hint.value)}</code>. Sign out and sign back in as that account to authorize the agent.`,
  });
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

function renderClaimPage(input: {
  status: "form" | "reveal" | "done" | "error";
  title: string;
  message: string;
  advisories?: Advisory[];
  claimAttemptToken?: string;
  userCode?: string;
}): string {
  const isError = input.status === "error";
  const headingColor = isError ? "var(--error)" : "var(--brand-primary)";

  const advisoryBlock = (input.advisories ?? [])
    .map((a) => `<div class="advisory">${renderAdvisory(a)}</div>`)
    .join("\n");

  const formBlock =
    input.status === "form"
      ? `
<form method="POST" action="/claim/confirm">
  <input type="hidden" name="claim_attempt_token" value="${escapeAttr(input.claimAttemptToken ?? "")}">
  <button type="submit">Authorize agent</button>
</form>
<p class="warn">Only authorize an agent you started this from. Confirming reveals a code that lets that agent act on your behalf.</p>
`
      : "";

  const codeBlock =
    input.status === "reveal" && input.userCode
      ? `
<div class="code">${escapeHtml(input.userCode)}</div>
<p class="warn">Read this code back to the agent that sent you here. Don't share it with anyone else.</p>
`
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
    --warn-bg: rgba(245, 158, 11, .08);
    --warn-border: rgba(245, 158, 11, .35);
    --warn-text: #8a5a00;
  }
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5; color: var(--brand-text); background: var(--brand-bg); }
  h1 { color: ${headingColor}; }
  p { color: var(--muted); }
  code { background: var(--surface-soft); padding: .05rem .3rem; border-radius: .2rem; font-size: .9em; }
  form { margin-top: 1.5rem; display: flex; flex-direction: column; gap: .75rem; }
  button { padding: .7rem 1rem; background: var(--brand-primary); color: white; border: none; border-radius: .35rem; font-weight: 600; font-size: 1rem; cursor: pointer; }
  button:hover { filter: brightness(1.08); }
  .code { margin: 1.5rem 0 .5rem; padding: 1rem; text-align: center; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 2.4rem; letter-spacing: .5rem; background: var(--surface-soft); border: 1px solid var(--border); border-radius: .5rem; color: var(--brand-text); }
  .warn { background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-text); padding: .6rem .8rem; border-radius: .35rem; font-size: .8rem; margin-top: 1rem; }
  .advisory { background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-text); padding: .65rem .8rem; border-radius: .35rem; font-size: .85rem; margin: .5rem 0; }
  .advisory + .advisory { margin-top: .4rem; }
</style>
</head>
<body>
<h1>${escapeHtml(input.title)}</h1>
<p>${input.message}</p>
${advisoryBlock}
${formBlock}
${codeBlock}
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

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
