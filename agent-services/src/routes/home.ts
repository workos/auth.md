import { Router } from "express";
import { config } from "../config.js";

export const homeRouter = Router();

homeRouter.get("/", (_req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderHtml());
});

function renderHtml(): string {
  const providerHint = config.trustedIssuers[0]?.iss ?? "http://localhost:4000";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agent Auth Consumer — Interactive Demo</title>
<style>
  :root {
    --brand-primary: #6D6DF2;
    --brand-primary-hover: #5252D9;
    --brand-success: #3FF1C7;
    --brand-success-hover: #2DD8AF;
    --brand-text: #030527;
    --brand-bg: #FFFFFF;
    --track-email: #f6b93b;
    --track-email-hover: #e0a52e;
    --error: #e55039;
    --error-bg: #fde9e6;
    --muted: rgba(3, 5, 39, .65);
    --muted-2: rgba(3, 5, 39, .5);
    --border: rgba(3, 5, 39, .12);
    --surface-soft: rgba(3, 5, 39, .04);
    --note-bg: rgba(109, 109, 242, .08);
    --note-border: rgba(109, 109, 242, .25);
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 100rem; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.5; color: var(--brand-text); background: var(--brand-bg); }
  .full { max-width: 52rem; margin: 0 auto; }
  .tracks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; align-items: start; margin-top: 1rem; }
  .tracks .track-header { margin: 0 0 .5rem; }
  .tracks section { margin: 0 0 1rem; }
  @media (max-width: 80rem) {
    .tracks { grid-template-columns: 1fr; }
  }
  h1 { margin-bottom: .25rem; }
  h2 { margin-top: 0; font-size: 1.1rem; }
  h2 .num { display: inline-block; width: 1.6rem; height: 1.6rem; line-height: 1.6rem; text-align: center; background: var(--brand-primary); color: white; border-radius: 50%; font-size: .85rem; margin-right: .5rem; vertical-align: 1px; }
  .sub { color: var(--muted); margin-top: 0; }
  .sub a { color: var(--brand-primary); }
  section { border: 1px solid var(--border); border-radius: .5rem; padding: 1rem 1.25rem; margin: 1rem 0; background: var(--brand-bg); }
  section[hidden] { display: none; }
  section.active { border-color: var(--brand-primary); box-shadow: 0 0 0 3px rgba(109, 109, 242, .15); }
  section.track-anon.active { border-color: var(--brand-success); box-shadow: 0 0 0 3px rgba(63, 241, 199, .2); }
  section.track-anon h2 .num { background: var(--brand-success); color: var(--brand-text); }
  section.track-email.active { border-color: var(--track-email); box-shadow: 0 0 0 3px rgba(246, 185, 59, .18); }
  section.track-email h2 .num { background: var(--track-email); color: var(--brand-text); }
  button { font-size: .95rem; padding: .4rem .9rem; margin: .25rem .4rem .25rem 0; border-radius: .3rem; border: 1px solid var(--border); background: var(--brand-bg); color: var(--brand-text); cursor: pointer; }
  button.primary { background: var(--brand-primary); color: white; border-color: var(--brand-primary); }
  button.primary:hover { background: var(--brand-primary-hover); }
  .track-anon button.primary { background: var(--brand-success); border-color: var(--brand-success); color: var(--brand-text); }
  .track-anon button.primary:hover { background: var(--brand-success-hover); }
  .track-email button.primary { background: var(--track-email); border-color: var(--track-email); color: var(--brand-text); }
  .track-email button.primary:hover { background: var(--track-email-hover); }
  button:hover { border-color: var(--brand-primary); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  input, select, textarea { font-size: .95rem; padding: .3rem .5rem; border: 1px solid var(--border); border-radius: .3rem; font-family: inherit; color: var(--brand-text); background: var(--brand-bg); }
  input { width: 100%; max-width: 28rem; }
  input.otp { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 1.2rem; letter-spacing: .25rem; max-width: 12rem; }
  textarea { width: 100%; min-height: 5rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .78rem; }
  label { display: block; margin-top: .5rem; font-size: .85rem; color: var(--muted); }
  label input, label select, label textarea { display: block; margin-top: .2rem; }
  .label { display: inline-block; font-size: .7rem; text-transform: uppercase; font-weight: 600; color: var(--muted); letter-spacing: .05em; margin: .5rem 0 .25rem; }
  .req, .res { background: var(--surface-soft); border: 1px solid var(--border); border-radius: .3rem; padding: .6rem .75rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .78rem; overflow-x: auto; }
  .req { border-left: 3px solid var(--brand-primary); }
  .res { border-left: 3px solid var(--brand-success); }
  .res.error { border-left-color: var(--error); background: var(--error-bg); }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; }
  code { background: var(--surface-soft); padding: .05rem .3rem; border-radius: .2rem; font-size: .9em; }
  .reset { float: right; }
  .badge { display: inline-block; font-size: .7rem; padding: .1rem .4rem; border-radius: .25rem; background: var(--surface-soft); color: var(--muted); font-family: ui-monospace, monospace; margin-left: .3rem; }
  .done .num { background: var(--brand-success); color: var(--brand-text); }
  .track-header { margin: 2rem 0 0; font-weight: 600; font-size: .9rem; text-transform: uppercase; letter-spacing: .05em; }
  .track-header.anon { color: var(--brand-success-hover); }
  .track-header.email { color: var(--track-email-hover); }
  .track-header.ia { color: var(--brand-primary); }
  .note { font-size: .85rem; color: var(--brand-text); background: var(--note-bg); border: 1px solid var(--note-border); padding: .5rem .75rem; border-radius: .3rem; }
</style>
</head>
<body>
<div class="full">
<h1>Agent Auth Consumer</h1>
<p class="sub">Interactive walk-through of three registration flows. Trusted issuer: <code>${providerHint}</code> — run the <a href="${providerHint}" target="_blank">provider sample</a> in parallel to mint real ID-JAGs. <button class="reset" type="button" id="reset">Reset</button></p>

<section id="step-1" class="active">
  <h2><span class="num">1</span>Unauthenticated probe</h2>
  <p>An agent without credentials hits <code>/api/resource</code> and gets a 401. The <code>WWW-Authenticate</code> header points at the Protected Resource Metadata doc the agent should read next.</p>
  <div class="label">Request</div>
  <div class="req"><pre>GET /api/resource</pre></div>
  <button class="primary" type="button" data-action="probe">Probe unauthenticated</button>
  <div id="probe-out"></div>
</section>

<section id="step-2" hidden>
  <h2><span class="num">2</span>Discovery</h2>
  <p>Following the hint from the 401, the agent fetches <code>/.well-known/oauth-protected-resource</code>. The PRM advertises an <code>authorization_servers</code> entry; the agent then fetches the standard <code>/.well-known/oauth-authorization-server</code> at that server. The <code>agent_auth</code> block describes the registration surface; the top-level <code>token_endpoint</code> and <code>revocation_endpoint</code> are standard OAuth 2.0.</p>
  <div class="label">Request</div>
  <div class="req"><pre>GET /.well-known/oauth-protected-resource</pre></div>
  <button class="primary" type="button" data-action="discover-prm">Fetch PRM</button>
  <div id="discover-prm-out"></div>
  <div id="discover-as-wrap" hidden>
    <div class="label" style="margin-top:1rem">Then fetch the AS metadata from <code>authorization_servers</code></div>
    <div class="req"><pre>GET /.well-known/oauth-authorization-server</pre></div>
    <button class="primary" type="button" data-action="discover-as">Fetch AS metadata</button>
    <div id="discover-as-out"></div>
  </div>
</section>

</div>

<div class="tracks">
<div class="track">
<p class="track-header anon" id="track-a-header" hidden>Track A — Anonymous + claim handoff</p>

<section id="step-3" class="track-anon" hidden>
  <h2><span class="num">3</span>Register anonymously</h2>
  <p>An agent without a user identity POSTs <code>{ "type": "anonymous" }</code> to <code>/agent/identity</code>. The service returns a service-signed assertion under <code>identity.assertion</code> plus a <code>claim.token</code> for the later human-handoff ceremony.</p>
  <div class="label">Request</div>
  <div class="req"><pre>POST /agent/identity
Content-Type: application/json

{ "type": "anonymous" }</pre></div>
  <button class="primary" type="button" data-action="anon-register">Register</button>
  <div id="anon-register-out"></div>
</section>

<section id="step-4" class="track-anon" hidden>
  <h2><span class="num">4</span>Exchange the assertion for a pre-claim access_token</h2>
  <p>The agent POSTs <code>identity.assertion</code> to <code>/oauth2/token</code> with the RFC 7523 JWT-bearer grant type. The response is a standard OAuth token envelope; the <code>scope</code> reflects the unclaimed pre-claim scope set.</p>
  <div class="label">Request</div>
  <div class="req" id="anon-exchange-req"><pre></pre></div>
  <button class="primary" type="button" data-action="anon-exchange">Exchange at /oauth2/token</button>
  <div id="anon-exchange-out"></div>
</section>

<section id="step-5" class="track-anon" hidden>
  <h2><span class="num">5</span>Call with the pre-claim access_token</h2>
  <p>The access_token works immediately, but only with the scopes configured for unclaimed registrations (here: <code>api.read</code>).</p>
  <button class="primary" type="button" data-action="anon-call-pre">Call /api/resource</button>
  <div id="anon-pre-out"></div>
</section>

<section id="step-6" class="track-anon" hidden>
  <h2><span class="num">6</span>Start the claim ceremony</h2>
  <p>The agent invites a human to take ownership. <code>POST /agent/identity/claim</code> — <code>type</code> is always <code>service_auth</code> (the claim method), even for an anonymous registration — returns an <code>attempt.verification_uri</code> to hand the user. No code comes back to the agent; it's shown to the user on the page.</p>
  <label>Claiming user email (login_hint)
    <input id="anon-claim-email" value="alice@example.com">
  </label>
  <div class="label">Request</div>
  <div class="req" id="anon-claim-req"><pre></pre></div>
  <button class="primary" type="button" data-action="anon-claim">Start ceremony</button>
  <div id="anon-claim-out"></div>
</section>

<section id="step-7" class="track-anon" hidden>
  <h2><span class="num">7</span>Hand off the link, then complete with the code</h2>
  <p>The agent gives the user the verification URL — no code. The user opens it, signs in, confirms, and the service-owned page <em>reveals</em> a 6-digit code. The user reads that code back to the agent, which submits it to <code>/agent/identity/claim/complete</code>. The code travels service → user → agent. Completion returns the post-claim <code>identity.assertion</code> and a rotating <code>refresh_token</code>, and revokes the pre-claim token.</p>
  <div id="anon-ceremony"></div>
  <label>Code the user read back
    <input class="otp" id="anon-user-code" maxlength="6" inputmode="numeric" placeholder="000000">
  </label>
  <button class="primary" type="button" data-action="anon-complete">Complete claim</button>
  <div id="anon-complete-out"></div>
</section>

<section id="step-8" class="track-anon" hidden>
  <h2><span class="num">8</span>Exchange the post-claim assertion</h2>
  <p>The post-claim <code>identity.assertion</code> goes back to <code>/oauth2/token</code> (same JWT-bearer grant). This one resolves to a claimed registration, so it mints an access_token with the full post-claim scope set.</p>
  <button class="primary" type="button" data-action="anon-exchange-post">Exchange at /oauth2/token</button>
  <div id="anon-exchange-post-out"></div>
</section>

<section id="step-9" class="track-anon" hidden>
  <h2><span class="num">9</span>Call with the post-claim access_token</h2>
  <p>The post-claim access_token carries the full scope set. The pre-claim access_token was revoked at ceremony completion.</p>
  <button class="primary" type="button" data-action="anon-call-post">Call /api/resource</button>
  <div id="anon-post-out"></div>
</section>

</div>

<div class="track">
<p class="track-header email" id="track-b-header" hidden>Track B — service_auth registration</p>

<section id="step-10" class="track-email" hidden>
  <h2><span class="num">10</span>Register with a service_auth login_hint</h2>
  <p>The agent has the user's email but no provider-signed assertion. It POSTs <code>/agent/identity</code> with <code>type: service_auth</code>. The response bundles the first attempt under <code>claim.attempt.verification_uri</code> — no separate <code>/claim</code> call needed.</p>
  <label>User email
    <input id="email-assertion" value="alice@example.com">
  </label>
  <div class="label">Request</div>
  <div class="req" id="email-register-req"><pre></pre></div>
  <button class="primary" type="button" data-action="email-register">Register</button>
  <div id="email-register-out"></div>
</section>

<section id="step-11" class="track-email" hidden>
  <h2><span class="num">11</span>Hand off the link, then complete with the code</h2>
  <p>Same handoff as Track A: the agent gives the user the verification URL; the user signs in, confirms, and reads back the 6-digit code the page reveals. The agent submits it to <code>/agent/identity/claim/complete</code> and collects the <code>identity.assertion</code> + <code>refresh_token</code>.</p>
  <div id="email-ceremony"></div>
  <label>Code the user read back
    <input class="otp" id="email-user-code" maxlength="6" inputmode="numeric" placeholder="000000">
  </label>
  <button class="primary" type="button" data-action="email-complete">Complete claim</button>
  <div id="email-complete-out"></div>
</section>

<section id="step-12" class="track-email" hidden>
  <h2><span class="num">12</span>Exchange the assertion at <code>/oauth2/token</code></h2>
  <p>The <code>identity.assertion</code> goes to the OAuth token endpoint with the RFC 7523 JWT-bearer grant; the response is a standard access_token with the post-claim scope set.</p>
  <div class="label">Request</div>
  <div class="req" id="email-token-req"><pre></pre></div>
  <button class="primary" type="button" data-action="email-exchange">Exchange</button>
  <div id="email-exchange-out"></div>
</section>

<section id="step-13" class="track-email" hidden>
  <h2><span class="num">13</span>Call <code>/api/resource</code></h2>
  <p>With the post-claim access_token the agent calls the protected API.</p>
  <button class="primary" type="button" data-action="email-call">Call /api/resource</button>
  <div id="email-call-out"></div>
  <p class="note" style="margin-top:1rem">When the assertion later expires, the agent doesn't re-register — it POSTs <code>{ "type": "refresh", "refresh_token": "…" }</code> to <code>/agent/identity</code> for a fresh assertion (and a rotated refresh token).</p>
</section>

</div>

<div class="track">
<p class="track-header ia" id="track-c-header" hidden>Track C — ID-JAG identity assertion</p>

<section id="step-14" hidden>
  <h2><span class="num">14</span>Exchange an ID-JAG for an identity assertion</h2>
  <p>Paste an ID-JAG minted by the provider (run the <a href="${providerHint}" target="_blank">provider demo</a> through its exchange step, then copy the <code>assertion</code> value). The consumer verifies the signature against the provider's JWKS, enforces replay protection, and returns a service-signed assertion under <code>identity.assertion</code> bound to the matched user.</p>
  <label>ID-JAG assertion
    <textarea id="assertion" placeholder="eyJhbGc..."></textarea>
  </label>
  <div class="label">Request</div>
  <div class="req" id="exchange-req"><pre></pre></div>
  <button class="primary" type="button" data-action="exchange">Exchange at /agent/identity</button>
  <div id="exchange-out"></div>
</section>

<section id="step-15" hidden>
  <h2><span class="num">15</span>Exchange the assertion at /oauth2/token</h2>
  <p>The service-signed <code>identity.assertion</code> goes to the OAuth token endpoint with the RFC 7523 JWT-bearer grant; the response is a standard access_token.</p>
  <div class="label">Request</div>
  <div class="req" id="token-req"><pre></pre></div>
  <button class="primary" type="button" data-action="token-exchange">Exchange</button>
  <div id="token-out"></div>
</section>

<section id="step-16" hidden>
  <h2><span class="num">16</span>Call <code>/api/resource</code></h2>
  <p>With a valid access_token, the agent calls the protected API. The response echoes back the resolved user and credential metadata.</p>
  <div class="label">Request</div>
  <div class="req" id="call-req"><pre></pre></div>
  <button class="primary" type="button" data-action="call">Call /api/resource</button>
  <div id="call-out"></div>
  <p class="note" style="margin-top:1rem">Revocation has two surfaces. RFC 7009 token revocation at <code>/oauth2/revoke</code> kills one access_token; the agent can re-exchange the identity assertion to mint a fresh one. The provider can also POST a <code>secevent+jwt</code> (RFC 8417 SET, delivered per RFC 8935) to <code>/agent/event/notify</code>, which invalidates all credentials for the <code>(iss, sub, aud)</code> — see the provider demo's revoke step.</p>
</section>
</div>
</div>

<script type="module">
const state = {};

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}
function jsonStr(v) { return JSON.stringify(v, null, 2); }
function resBlock(status, headers, body, ok) {
  const cls = ok ? "res" : "res error";
  const headerLines = headers && Object.keys(headers).length
    ? Object.entries(headers).map(([k, v]) => k + ": " + v).join("\\n") + "\\n\\n"
    : "";
  const text = body === undefined || body === "" ? "(no body)" : (typeof body === "string" ? body : jsonStr(body));
  return '<div class="label">Response ' + status + '</div>' +
         '<div class="' + cls + '"><pre>' + escapeHtml(headerLines + text) + '</pre></div>';
}

async function jsonFetch(path, init = {}) {
  const headers = { "content-type": "application/json", ...(init.headers || {}) };
  const r = await fetch(path, { ...init, headers });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : ""; } catch { body = text; }
  const pickedHeaders = {};
  for (const h of ["www-authenticate", "cache-control", "content-type"]) {
    const v = r.headers.get(h);
    if (v) pickedHeaders[h] = v;
  }
  return { status: r.status, ok: r.ok, body, headers: pickedHeaders };
}

async function formFetch(path, body) {
  const params = new URLSearchParams(body);
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await r.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : ""; } catch { parsed = text; }
  return { status: r.status, ok: r.ok, body: parsed };
}

function markDone(stepId) {
  document.getElementById(stepId).classList.add("done");
}
function reveal(stepId) {
  document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
  const el = document.getElementById(stepId);
  el.hidden = false;
  el.classList.add("active");
}

function abbrev(s) { return s ? s.slice(0, 24) + "..." : "<value>"; }

function updateExchangePreview() {
  const body = {
    type: "identity_assertion",
    assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
    assertion: abbrev(document.getElementById("assertion").value || "eyJhbGc..."),
  };
  document.querySelector("#exchange-req pre").textContent =
    "POST /agent/identity\\nContent-Type: application/json\\n\\n" + jsonStr(body);
}
function updateTokenPreview() {
  const params = "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" +
    abbrev(state.identity_assertion);
  document.querySelector("#token-req pre").textContent =
    "POST /oauth2/token\\nContent-Type: application/x-www-form-urlencoded\\n\\n" + params;
}
function updateCallPreview() {
  const tok = state.access_token ? state.access_token.slice(0, 16) + "..." : "<access_token>";
  document.querySelector("#call-req pre").textContent =
    "GET /api/resource\\nAuthorization: Bearer " + tok;
}
function updateAnonExchangePreview() {
  const params = "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" +
    abbrev(state.anon_assertion);
  document.querySelector("#anon-exchange-req pre").textContent =
    "POST /oauth2/token\\nContent-Type: application/x-www-form-urlencoded\\n\\n" + params;
}
function updateAnonClaimPreview() {
  const body = {
    type: "service_auth",
    claim_token: abbrev(state.anon_claim_token),
    login_hint: document.getElementById("anon-claim-email").value,
  };
  document.querySelector("#anon-claim-req pre").textContent =
    "POST /agent/identity/claim\\nContent-Type: application/json\\n\\n" + jsonStr(body);
}
function updateEmailRegisterPreview() {
  const body = {
    type: "service_auth",
    login_hint: document.getElementById("email-assertion").value,
  };
  document.querySelector("#email-register-req pre").textContent =
    "POST /agent/identity\\nContent-Type: application/json\\n\\n" + jsonStr(body);
}
function updateEmailTokenPreview() {
  const params = "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" +
    abbrev(state.email_assertion);
  document.querySelector("#email-token-req pre").textContent =
    "POST /oauth2/token\\nContent-Type: application/x-www-form-urlencoded\\n\\n" + params;
}

/*
 * Renders the verification link the agent hands to the user. No code here —
 * the user_code is shown to the user on the service-owned claim page and read
 * back to the agent.
 */
function renderCeremony(containerId, verificationUri) {
  document.getElementById(containerId).innerHTML =
    '<div class="note">' +
    '<p style="margin: 0 0 .5rem; color: var(--brand-text);"><strong>Give the user this link (open it to run the ceremony):</strong></p>' +
    '<p style="margin: 0;"><a href="' + escapeHtml(verificationUri) + '" target="_blank">' +
      escapeHtml(verificationUri) + '</a></p>' +
    '<p style="margin: .5rem 0 0; font-size: .8rem;">They sign in, confirm, and read back the 6-digit code the page shows. Paste it below.</p>' +
    '</div>';
}

document.getElementById("assertion").addEventListener("input", updateExchangePreview);
document.getElementById("anon-claim-email").addEventListener("input", updateAnonClaimPreview);
document.getElementById("email-assertion").addEventListener("input", updateEmailRegisterPreview);

updateExchangePreview();
updateTokenPreview();
updateCallPreview();
updateAnonExchangePreview();
updateAnonClaimPreview();
updateEmailRegisterPreview();

document.body.addEventListener("click", (e) => {
  const a = e.target instanceof HTMLElement ? e.target.dataset.action : null;
  if (!a) return;
  if (a === "probe") probe();
  if (a === "discover-prm") discoverPrm();
  if (a === "discover-as") discoverAs();
  if (a === "anon-register") anonRegister();
  if (a === "anon-exchange") anonExchange();
  if (a === "anon-call-pre") anonCallPre();
  if (a === "anon-claim") anonClaim();
  if (a === "anon-complete") anonComplete();
  if (a === "anon-exchange-post") anonExchangePost();
  if (a === "anon-call-post") anonCallPost();
  if (a === "email-register") emailRegister();
  if (a === "email-complete") emailComplete();
  if (a === "email-exchange") emailExchange();
  if (a === "email-call") emailCall();
  if (a === "exchange") exchange();
  if (a === "token-exchange") tokenExchange();
  if (a === "call") call();
});
document.getElementById("reset").addEventListener("click", () => location.reload());

async function probe() {
  const r = await fetch("/api/resource");
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : ""; } catch { body = text; }
  const headers = {};
  const wa = r.headers.get("www-authenticate");
  if (wa) headers["www-authenticate"] = wa;
  document.getElementById("probe-out").innerHTML = resBlock(r.status, headers, body, r.ok);
  markDone("step-1");
  reveal("step-2");
}

async function discoverPrm() {
  const r = await jsonFetch("/.well-known/oauth-protected-resource");
  document.getElementById("discover-prm-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (r.ok) {
    document.getElementById("discover-as-wrap").hidden = false;
  }
}

async function discoverAs() {
  const r = await jsonFetch("/.well-known/oauth-authorization-server");
  document.getElementById("discover-as-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  markDone("step-2");
  document.getElementById("track-a-header").hidden = false;
  document.getElementById("track-b-header").hidden = false;
  document.getElementById("track-c-header").hidden = false;
  document.getElementById("step-10").hidden = false;
  document.getElementById("step-14").hidden = false;
  reveal("step-3");
}

async function anonRegister() {
  const r = await jsonFetch("/agent/identity", {
    method: "POST",
    body: JSON.stringify({ type: "anonymous" }),
  });
  document.getElementById("anon-register-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.anon_assertion = r.body.identity.assertion;
  state.anon_claim_token = r.body.claim.token;
  state.anon_registration_id = r.body.id;
  updateAnonExchangePreview();
  updateAnonClaimPreview();
  markDone("step-3");
  reveal("step-4");
}

async function anonExchange() {
  const r = await formFetch("/oauth2/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: state.anon_assertion,
  });
  document.getElementById("anon-exchange-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.anon_access_token = r.body.access_token;
  markDone("step-4");
  reveal("step-5");
}

async function anonCallPre() {
  const r = await jsonFetch("/api/resource", {
    headers: { authorization: "Bearer " + state.anon_access_token },
  });
  document.getElementById("anon-pre-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (r.ok) { markDone("step-5"); reveal("step-6"); }
}

async function anonClaim() {
  const body = {
    type: "service_auth",
    claim_token: state.anon_claim_token,
    login_hint: document.getElementById("anon-claim-email").value,
  };
  const r = await jsonFetch("/agent/identity/claim", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("anon-claim-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  renderCeremony("anon-ceremony", r.body.attempt.verification_uri);
  markDone("step-6");
  reveal("step-7");
}

async function anonComplete() {
  const body = {
    claim_token: state.anon_claim_token,
    user_code: document.getElementById("anon-user-code").value.trim(),
  };
  const r = await jsonFetch("/agent/identity/claim/complete", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("anon-complete-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  /* Post-claim identity: v2 assertion (now carries the user's email) + refresh token. */
  state.anon_assertion = r.body.identity.assertion;
  state.anon_refresh_token = r.body.identity.refresh_token.value;
  updateAnonExchangePreview();
  markDone("step-7");
  reveal("step-8");
}

async function anonExchangePost() {
  const r = await formFetch("/oauth2/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: state.anon_assertion,
  });
  document.getElementById("anon-exchange-post-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.anon_access_token = r.body.access_token;
  markDone("step-8");
  reveal("step-9");
}

async function anonCallPost() {
  const r = await jsonFetch("/api/resource", {
    headers: { authorization: "Bearer " + state.anon_access_token },
  });
  document.getElementById("anon-post-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (r.ok) markDone("step-9");
}

async function emailRegister() {
  const email = document.getElementById("email-assertion").value.trim();
  const body = {
    type: "service_auth",
    login_hint: email,
  };
  const r = await jsonFetch("/agent/identity", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("email-register-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.email_claim_token = r.body.claim.token;
  state.email_registration_id = r.body.id;
  renderCeremony("email-ceremony", r.body.claim.attempt.verification_uri);
  markDone("step-10");
  reveal("step-11");
}

async function emailComplete() {
  const body = {
    claim_token: state.email_claim_token,
    user_code: document.getElementById("email-user-code").value.trim(),
  };
  const r = await jsonFetch("/agent/identity/claim/complete", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("email-complete-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.email_assertion = r.body.identity.assertion;
  state.email_refresh_token = r.body.identity.refresh_token.value;
  updateEmailTokenPreview();
  markDone("step-11");
  reveal("step-12");
}

async function emailExchange() {
  const r = await formFetch("/oauth2/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: state.email_assertion,
  });
  document.getElementById("email-exchange-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.email_access_token = r.body.access_token;
  markDone("step-12");
  reveal("step-13");
}

async function emailCall() {
  const r = await jsonFetch("/api/resource", {
    headers: { authorization: "Bearer " + state.email_access_token },
  });
  document.getElementById("email-call-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (r.ok) markDone("step-13");
}

async function exchange() {
  const assertion = document.getElementById("assertion").value.trim();
  if (!assertion) {
    document.getElementById("exchange-out").innerHTML =
      '<div class="res error"><pre>Paste an ID-JAG from the provider demo first.</pre></div>';
    return;
  }
  const body = {
    type: "identity_assertion",
    assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
    assertion,
  };
  const r = await jsonFetch("/agent/identity", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("exchange-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.identity_assertion = r.body.identity.assertion;
  updateTokenPreview();
  markDone("step-14");
  reveal("step-15");
}

async function tokenExchange() {
  const r = await formFetch("/oauth2/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: state.identity_assertion,
  });
  document.getElementById("token-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.access_token = r.body.access_token;
  updateCallPreview();
  markDone("step-15");
  reveal("step-16");
}

async function call() {
  const r = await jsonFetch("/api/resource", {
    headers: { authorization: "Bearer " + state.access_token },
  });
  document.getElementById("call-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (r.ok) markDone("step-16");
}
</script>
</body></html>`;
}
