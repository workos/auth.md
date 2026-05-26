import { Router } from "express";
import { config } from "../config.js";

export const homeRouter = Router();

homeRouter.get("/", (_req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderHtml());
});

function renderHtml(): string {
  const providerHint = config.trustedIssuers[0] ?? "http://localhost:4000";
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
  <p>Following the hint from the 401, the agent fetches <code>/.well-known/oauth-protected-resource</code>. The PRM advertises an <code>authorization_servers</code> entry; the agent then fetches the standard <code>/.well-known/oauth-authorization-server</code> at that server for the <code>agent_auth</code> block describing supported registration flows.</p>
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
<p class="track-header anon" id="track-a-header" hidden>Track A — Anonymous + OTP claim</p>

<section id="step-3" class="track-anon" hidden>
  <h2><span class="num">3</span>Register anonymously</h2>
  <p>An agent without a user identity POSTs <code>{ "type": "anonymous" }</code>. The service returns an <code>identity_assertion</code> (a service-signed ID-JAG) plus a <code>claim_token</code> for the human-handoff ceremony. No credential yet — the agent will exchange the assertion at <code>/oauth2/token</code> next.</p>
  <div class="label">Request</div>
  <div class="req"><pre>POST /agent/register
Content-Type: application/json

{ "type": "anonymous" }</pre></div>
  <button class="primary" type="button" data-action="anon-register">Register</button>
  <div id="anon-register-out"></div>
</section>

<section id="step-4" class="track-anon" hidden>
  <h2><span class="num">4</span>Exchange the assertion for a credential</h2>
  <p>The agent POSTs the <code>identity_assertion</code> to <code>/oauth2/token</code> via the RFC 7523 JWT-bearer grant. The service returns an <code>access_token</code> at the pre-claim scope set (here: <code>api.read</code>), and the agent uses it to call <code>/api/resource</code>.</p>
  <button class="primary" type="button" data-action="anon-call-pre">Exchange &amp; call</button>
  <div id="anon-pre-out"></div>
</section>

<section id="step-5" class="track-anon" hidden>
  <h2><span class="num">5</span>Send the claim email</h2>
  <p>The agent invites a human to take ownership. <code>POST /agent/register/claim</code> records the request and sends an email containing a <code>claim_attempt_token</code> URL (written to <code>agent-services/.mail/&lt;registration_id&gt;.html</code>, served at <code>/mail/&lt;registration_id&gt;.html</code>).</p>
  <label>Claiming user email
    <input id="anon-claim-email" value="alice@example.com">
  </label>
  <div class="label">Request</div>
  <div class="req" id="anon-claim-req"><pre></pre></div>
  <button class="primary" type="button" data-action="anon-claim">Send claim email</button>
  <div id="anon-claim-out"></div>
</section>

<section id="step-6" class="track-anon" hidden>
  <h2><span class="num">6</span>User opens the email and reads the OTP</h2>
  <p>The user clicks the link in the email and lands on <code>/agent/register/claim/view</code>. The page POSTs the <code>claim_attempt_token</code> to <code>/agent/register/claim/attempt/challenge</code>, which mints a 6-digit OTP that the page displays. They read the code back to the agent.</p>
  <div id="anon-mail-link"></div>
</section>

<section id="step-7" class="track-anon" hidden>
  <h2><span class="num">7</span>Complete the claim</h2>
  <p>The agent POSTs the OTP it heard from the user to <code>/agent/register/claim/complete</code>. The pre-claim access_token keeps working — its scopes are upgraded in place on the credential issued in step 4.</p>
  <label>OTP from user
    <input id="anon-otp" class="otp" placeholder="123456" maxlength="6">
  </label>
  <div class="label">Request</div>
  <div class="req" id="anon-complete-req"><pre></pre></div>
  <button class="primary" type="button" data-action="anon-complete">Complete claim</button>
  <div id="anon-complete-out"></div>
</section>

<section id="step-8" class="track-anon" hidden>
  <h2><span class="num">8</span>Call with the post-claim credential</h2>
  <p>Same token, wider scope. The credential's <code>user_id</code> is now linked to the claiming user — before claim it had no user binding at all.</p>
  <button class="primary" type="button" data-action="anon-call-post">Call /api/resource</button>
  <div id="anon-post-out"></div>
</section>

</div>

<div class="track">
<p class="track-header email" id="track-b-header" hidden>Track B — Email-verification registration</p>

<section id="step-9" class="track-email" hidden>
  <h2><span class="num">9</span>Register with an email assertion</h2>
  <p>The agent already has the user's email but no provider-signed assertion. It POSTs <code>/agent/register</code> with <code>assertion_type: verified_email</code>. The service mails the user immediately and returns a claim_token, but no credential yet.</p>
  <label>User email
    <input id="email-assertion" value="alice@example.com">
  </label>
  <div class="label">Request</div>
  <div class="req" id="email-register-req"><pre></pre></div>
  <button class="primary" type="button" data-action="email-register">Register</button>
  <div id="email-register-out"></div>
</section>

<section id="step-10" class="track-email" hidden>
  <h2><span class="num">10</span>User opens the email and reads the OTP</h2>
  <p>Same OTP page as Track A — the user reads the 6-digit code back to the agent.</p>
  <div id="email-mail-link"></div>
</section>

<section id="step-11" class="track-email" hidden>
  <h2><span class="num">11</span>Complete the claim, receive an identity_assertion</h2>
  <p>The agent POSTs the OTP to <code>/agent/register/claim/complete</code>. The service marks the registration claimed and returns a service-signed <code>identity_assertion</code> the agent will exchange for a credential next.</p>
  <label>OTP from user
    <input id="email-otp" class="otp" placeholder="123456" maxlength="6">
  </label>
  <div class="label">Request</div>
  <div class="req" id="email-complete-req"><pre></pre></div>
  <button class="primary" type="button" data-action="email-complete">Complete claim</button>
  <div id="email-complete-out"></div>
</section>

<section id="step-12" class="track-email" hidden>
  <h2><span class="num">12</span>Exchange the assertion and call /api/resource</h2>
  <p>The agent POSTs the <code>identity_assertion</code> to <code>/oauth2/token</code> and uses the resulting access_token to call the protected API.</p>
  <button class="primary" type="button" data-action="email-call">Exchange &amp; call</button>
  <div id="email-call-out"></div>
</section>

</div>

<div class="track">
<p class="track-header ia" id="track-c-header" hidden>Track C — ID-JAG identity assertion</p>

<section id="step-13" hidden>
  <h2><span class="num">13</span>Exchange an ID-JAG for a service identity_assertion</h2>
  <p>Paste an ID-JAG minted by the provider (run the <a href="${providerHint}" target="_blank">provider demo</a> through step 5, then copy the <code>assertion</code> value). The consumer verifies the signature against the provider's JWKS, enforces replay protection, matches or provisions a user, and returns a service-signed <code>identity_assertion</code> bound to the registration.</p>
  <label>ID-JAG assertion
    <textarea id="assertion" placeholder="eyJhbGc..."></textarea>
  </label>
  <div class="label">Request</div>
  <div class="req" id="exchange-req"><pre></pre></div>
  <button class="primary" type="button" data-action="exchange">Exchange</button>
  <div id="exchange-out"></div>
</section>

<section id="step-14" hidden>
  <h2><span class="num">14</span>Exchange the assertion at <code>/oauth2/token</code> and call <code>/api/resource</code></h2>
  <p>The agent POSTs the service-signed <code>identity_assertion</code> to <code>/oauth2/token</code> (RFC 7523 JWT-bearer grant) to mint an access_token, then uses it against the protected API. The response echoes back the resolved user and credential metadata.</p>
  <div class="label">Request</div>
  <div class="req" id="call-req"><pre></pre></div>
  <button class="primary" type="button" data-action="call">Exchange &amp; call</button>
  <div id="call-out"></div>
  <p class="note" style="margin-top:1rem">Revocation is driven from the provider side — see the provider demo's step 7. When the provider POSTs a Security Event Token (<code>application/secevent+jwt</code>, RFC 8417) to this consumer's <code>/agent/event/notify</code>, credentials for that <code>(iss, sub, aud)</code> are marked revoked. Re-clicking the call button will start returning 401.</p>
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

function markDone(stepId) {
  document.getElementById(stepId).classList.add("done");
}
function reveal(stepId) {
  document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
  const el = document.getElementById(stepId);
  el.hidden = false;
  el.classList.add("active");
}

function updateExchangePreview() {
  const body = {
    type: "identity_assertion",
    assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
    assertion: (document.getElementById("assertion").value || "eyJhbGc...").slice(0, 40) + "...",
  };
  document.querySelector("#exchange-req pre").textContent =
    "POST /agent/register\\nContent-Type: application/json\\n\\n" + jsonStr(body);
}
function updateCallPreview() {
  const tok = state.credential ? state.credential.slice(0, 16) + "..." : "<credential>";
  document.querySelector("#call-req pre").textContent =
    "GET /api/resource\\nAuthorization: Bearer " + tok;
}
function updateAnonClaimPreview() {
  const body = {
    claim_token: state.anon_claim_token ? state.anon_claim_token.slice(0, 16) + "..." : "<claim_token>",
    email: document.getElementById("anon-claim-email").value,
  };
  document.querySelector("#anon-claim-req pre").textContent =
    "POST /agent/register/claim\\nContent-Type: application/json\\n\\n" + jsonStr(body);
}
function updateAnonCompletePreview() {
  const body = {
    claim_token: state.anon_claim_token ? state.anon_claim_token.slice(0, 16) + "..." : "<claim_token>",
    otp: document.getElementById("anon-otp").value || "<otp>",
  };
  document.querySelector("#anon-complete-req pre").textContent =
    "POST /agent/register/claim/complete\\nContent-Type: application/json\\n\\n" + jsonStr(body);
}
function updateEmailRegisterPreview() {
  const body = {
    type: "identity_assertion",
    assertion_type: "verified_email",
    assertion: document.getElementById("email-assertion").value,
  };
  document.querySelector("#email-register-req pre").textContent =
    "POST /agent/register\\nContent-Type: application/json\\n\\n" + jsonStr(body);
}
function updateEmailCompletePreview() {
  const body = {
    claim_token: state.email_claim_token ? state.email_claim_token.slice(0, 16) + "..." : "<claim_token>",
    otp: document.getElementById("email-otp").value || "<otp>",
  };
  document.querySelector("#email-complete-req pre").textContent =
    "POST /agent/register/claim/complete\\nContent-Type: application/json\\n\\n" + jsonStr(body);
}

document.getElementById("assertion").addEventListener("input", updateExchangePreview);
document.getElementById("anon-claim-email").addEventListener("input", updateAnonClaimPreview);
document.getElementById("anon-otp").addEventListener("input", updateAnonCompletePreview);
document.getElementById("email-assertion").addEventListener("input", updateEmailRegisterPreview);
document.getElementById("email-otp").addEventListener("input", updateEmailCompletePreview);

updateExchangePreview();
updateCallPreview();
updateAnonClaimPreview();
updateAnonCompletePreview();
updateEmailRegisterPreview();
updateEmailCompletePreview();

document.body.addEventListener("click", (e) => {
  const a = e.target instanceof HTMLElement ? e.target.dataset.action : null;
  if (!a) return;
  if (a === "probe") probe();
  if (a === "discover-prm") discoverPrm();
  if (a === "discover-as") discoverAs();
  if (a === "anon-register") anonRegister();
  if (a === "anon-call-pre") anonCallPre();
  if (a === "anon-claim") anonClaim();
  if (a === "anon-complete") anonComplete();
  if (a === "anon-call-post") anonCallPost();
  if (a === "email-register") emailRegister();
  if (a === "email-complete") emailComplete();
  if (a === "email-call") emailCall();
  if (a === "exchange") exchange();
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
  // Reveal all three track headers + first steps together so the user sees
  // the menu of choices.
  document.getElementById("track-a-header").hidden = false;
  document.getElementById("track-b-header").hidden = false;
  document.getElementById("track-c-header").hidden = false;
  document.getElementById("step-9").hidden = false;
  document.getElementById("step-13").hidden = false;
  reveal("step-3");
}

async function exchangeForToken(assertion) {
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const resp = await fetch("/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await resp.text();
  let body; try { body = text ? JSON.parse(text) : ""; } catch { body = text; }
  return { status: resp.status, ok: resp.ok, body };
}

function tokenAndResourceBlocks(tokResp, resResp) {
  const tokenLabel = '<div class="label">POST /oauth2/token</div>';
  const resLabel = '<div class="label">GET /api/resource</div>';
  const tokenBlock = tokenLabel + resBlock(tokResp.status, null, tokResp.body, tokResp.ok);
  if (!resResp) return tokenBlock;
  return tokenBlock + resLabel + resBlock(resResp.status, null, resResp.body, resResp.ok);
}

async function anonRegister() {
  const r = await jsonFetch("/agent/register", {
    method: "POST",
    body: JSON.stringify({ type: "anonymous" }),
  });
  document.getElementById("anon-register-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.anon_identity_assertion = r.body.identity_assertion;
  state.anon_claim_token = r.body.claim_token;
  state.anon_registration_id = r.body.registration_id;
  updateAnonClaimPreview();
  updateAnonCompletePreview();
  markDone("step-3");
  reveal("step-4");
}

async function anonCallPre() {
  const tokResp = await exchangeForToken(state.anon_identity_assertion);
  if (!tokResp.ok) {
    document.getElementById("anon-pre-out").innerHTML = tokenAndResourceBlocks(tokResp, null);
    return;
  }
  state.anon_credential = tokResp.body.access_token;
  const resResp = await jsonFetch("/api/resource", {
    headers: { authorization: "Bearer " + state.anon_credential },
  });
  document.getElementById("anon-pre-out").innerHTML = tokenAndResourceBlocks(tokResp, resResp);
  if (resResp.ok) { markDone("step-4"); reveal("step-5"); }
}

async function anonClaim() {
  const body = {
    claim_token: state.anon_claim_token,
    email: document.getElementById("anon-claim-email").value,
  };
  const r = await jsonFetch("/agent/register/claim", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("anon-claim-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  const mailUrl = "/mail/" + state.anon_registration_id + ".html";
  document.getElementById("anon-mail-link").innerHTML =
    '<div class="note"><a href="' + escapeHtml(mailUrl) + '" target="_blank">Open the simulated email</a> ' +
    '— click the link inside, read the 6-digit OTP, then come back and paste it below.</div>';
  markDone("step-5");
  reveal("step-6");
  document.getElementById("step-7").hidden = false;
}

async function anonComplete() {
  const otp = document.getElementById("anon-otp").value.trim();
  const body = { claim_token: state.anon_claim_token, otp };
  const r = await jsonFetch("/agent/register/claim/complete", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("anon-complete-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  markDone("step-6");
  markDone("step-7");
  reveal("step-8");
}

async function anonCallPost() {
  const r = await jsonFetch("/api/resource", {
    headers: { authorization: "Bearer " + state.anon_credential },
  });
  document.getElementById("anon-post-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (r.ok) markDone("step-8");
}

async function emailRegister() {
  const email = document.getElementById("email-assertion").value.trim();
  const body = {
    type: "identity_assertion",
    assertion_type: "verified_email",
    assertion: email,
  };
  const r = await jsonFetch("/agent/register", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("email-register-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.email_claim_token = r.body.claim_token;
  state.email_registration_id = r.body.registration_id;
  updateEmailCompletePreview();
  const mailUrl = "/mail/" + state.email_registration_id + ".html";
  document.getElementById("email-mail-link").innerHTML =
    '<div class="note"><a href="' + escapeHtml(mailUrl) + '" target="_blank">Open the simulated email</a> ' +
    '— click the link, read the 6-digit OTP, then come back and paste it below.</div>';
  markDone("step-9");
  reveal("step-10");
  document.getElementById("step-11").hidden = false;
}

async function emailComplete() {
  const otp = document.getElementById("email-otp").value.trim();
  const body = { claim_token: state.email_claim_token, otp };
  const r = await jsonFetch("/agent/register/claim/complete", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("email-complete-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.email_identity_assertion = r.body.identity_assertion;
  markDone("step-10");
  markDone("step-11");
  reveal("step-12");
}

async function emailCall() {
  const tokResp = await exchangeForToken(state.email_identity_assertion);
  if (!tokResp.ok) {
    document.getElementById("email-call-out").innerHTML = tokenAndResourceBlocks(tokResp, null);
    return;
  }
  state.email_credential = tokResp.body.access_token;
  const resResp = await jsonFetch("/api/resource", {
    headers: { authorization: "Bearer " + state.email_credential },
  });
  document.getElementById("email-call-out").innerHTML = tokenAndResourceBlocks(tokResp, resResp);
  if (resResp.ok) markDone("step-12");
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
  const r = await jsonFetch("/agent/register", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("exchange-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.identity_assertion = r.body.identity_assertion;
  updateCallPreview();
  markDone("step-13");
  reveal("step-14");
}

async function call() {
  const tokResp = await exchangeForToken(state.identity_assertion);
  if (!tokResp.ok) {
    document.getElementById("call-out").innerHTML = tokenAndResourceBlocks(tokResp, null);
    return;
  }
  state.credential = tokResp.body.access_token;
  const resResp = await jsonFetch("/api/resource", {
    headers: { authorization: "Bearer " + state.credential },
  });
  document.getElementById("call-out").innerHTML = tokenAndResourceBlocks(tokResp, resResp);
  if (resResp.ok) markDone("step-14");
}
</script>
</body></html>`;
}
