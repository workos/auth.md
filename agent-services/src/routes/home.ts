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
  <p>An agent without a user identity POSTs <code>{ "type": "anonymous" }</code> to <code>/agent/identity</code>. The service returns a service-signed <code>identity_assertion</code> bound to the new registration plus a <code>claim_token</code> for the human-handoff ceremony.</p>
  <div class="label">Request</div>
  <div class="req"><pre>POST /agent/identity
Content-Type: application/json

{ "type": "anonymous" }</pre></div>
  <button class="primary" type="button" data-action="anon-register">Register</button>
  <div id="anon-register-out"></div>
</section>

<section id="step-4" class="track-anon" hidden>
  <h2><span class="num">4</span>Exchange the assertion for a pre-claim access_token</h2>
  <p>The agent POSTs the <code>identity_assertion</code> to <code>/oauth2/token</code> with the RFC 7523 JWT-bearer grant type. The response is a standard OAuth token envelope; the <code>scope</code> reflects the unclaimed pre-claim scope set.</p>
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
  <h2><span class="num">6</span>Initiate the claim ceremony</h2>
  <p>The agent invites a human to take ownership. <code>POST /agent/identity/claim</code> returns a <code>user_code</code> (to surface to the user) and a <code>verification_uri</code> (where they sign in and type the code). Shape follows <a href="https://datatracker.ietf.org/doc/html/rfc8628" target="_blank">RFC 8628 device authorization</a>.</p>
  <label>Claiming user email
    <input id="anon-claim-email" value="alice@example.com">
  </label>
  <div class="label">Request</div>
  <div class="req" id="anon-claim-req"><pre></pre></div>
  <button class="primary" type="button" data-action="anon-claim">Start ceremony</button>
  <div id="anon-claim-out"></div>
</section>

<section id="step-7" class="track-anon" hidden>
  <h2><span class="num">7</span>Surface the code to the user</h2>
  <p>The agent shows the user the verification URL and the 6-digit code. The user opens the URL, signs in to the service, and types the code on the service-owned claim page. The code travels agent → user → service — it never goes back to the agent.</p>
  <div id="anon-ceremony"></div>
</section>

<section id="step-8" class="track-anon" hidden>
  <h2><span class="num">8</span>Poll <code>/oauth2/token</code> with the claim grant</h2>
  <p>Polling happens at the standard token endpoint with a profile-specific grant (<code>urn:workos:agent-auth:grant-type:claim</code>) — custom URN, so it doesn't collide with services that also implement standard RFC 8628 device auth. While the user is still in the ceremony: <code>{ "error": "authorization_pending" }</code>. On completion: a standard OAuth token response, with a fresh post-claim access_token plus a v2 <code>identity_assertion</code> (this one has the user's email populated, unlike the pre-claim v1).</p>
  <button class="primary" type="button" data-action="anon-poll">Poll once</button>
  <div id="anon-poll-out"></div>
</section>

<section id="step-9" class="track-anon" hidden>
  <h2><span class="num">9</span>Call with the post-claim access_token</h2>
  <p>The access_token from the claim grant has the full post-claim scope set. The pre-claim access_token was revoked at ceremony completion.</p>
  <button class="primary" type="button" data-action="anon-call-post">Call /api/resource</button>
  <div id="anon-post-out"></div>
</section>

</div>

<div class="track">
<p class="track-header email" id="track-b-header" hidden>Track B — Email-verification registration</p>

<section id="step-10" class="track-email" hidden>
  <h2><span class="num">10</span>Register with an email assertion</h2>
  <p>The agent has the user's email but no provider-signed assertion. It POSTs <code>/agent/identity</code> with <code>type: service_auth</code>. The response bundles the ceremony block (<code>user_code</code>, <code>verification_uri</code>, <code>interval</code>) — no separate <code>/claim</code> call needed.</p>
  <label>User email
    <input id="email-assertion" value="alice@example.com">
  </label>
  <div class="label">Request</div>
  <div class="req" id="email-register-req"><pre></pre></div>
  <button class="primary" type="button" data-action="email-register">Register</button>
  <div id="email-register-out"></div>
</section>

<section id="step-11" class="track-email" hidden>
  <h2><span class="num">11</span>Surface the code to the user</h2>
  <p>Same as Track A: the agent shows the user the verification URL and the 6-digit code. The user signs in to the service (as the asserted email) and types the code on the claim page.</p>
  <div id="email-ceremony"></div>
</section>

<section id="step-12" class="track-email" hidden>
  <h2><span class="num">12</span>Poll <code>/oauth2/token</code> with the claim grant</h2>
  <p>Same poll endpoint as Track A. While pending: <code>{ "error": "authorization_pending" }</code>. On completion: standard OAuth token response with a fresh access_token plus an <code>identity_assertion</code> (the agent uses this for jwt-bearer refreshes when the access_token expires).</p>
  <button class="primary" type="button" data-action="email-poll">Poll once</button>
  <div id="email-poll-out"></div>
</section>

<section id="step-13" class="track-email" hidden>
  <h2><span class="num">13</span>Call <code>/api/resource</code></h2>
  <p>The access_token from the claim grant goes straight to the API. No re-exchange needed — the claim grant already returned a usable credential.</p>
  <button class="primary" type="button" data-action="email-call">Call /api/resource</button>
  <div id="email-call-out"></div>
</section>

</div>

<div class="track">
<p class="track-header ia" id="track-c-header" hidden>Track C — ID-JAG identity assertion</p>

<section id="step-14" hidden>
  <h2><span class="num">14</span>Exchange an ID-JAG for an identity_assertion</h2>
  <p>Paste an ID-JAG minted by the provider (run the <a href="${providerHint}" target="_blank">provider demo</a> through its exchange step, then copy the <code>assertion</code> value). The consumer verifies the signature against the provider's JWKS, enforces replay protection, and returns a service-signed identity_assertion bound to the matched user.</p>
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
  <p>The service-signed identity_assertion goes to the OAuth token endpoint with the RFC 7523 JWT-bearer grant; the response is a standard access_token.</p>
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
  <p class="note" style="margin-top:1rem">Revocation has two surfaces. RFC 7009 token revocation at <code>/oauth2/revoke</code> kills one access_token; the agent can re-exchange the identity_assertion to mint a fresh one. The provider can also POST a <code>secevent+jwt</code> (RFC 8417 SET, delivered per RFC 8935) to <code>/agent/event/notify</code>, which invalidates all credentials for the <code>(iss, sub, aud)</code> — see the provider demo's revoke step.</p>
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
    abbrev(state.anon_identity_assertion);
  document.querySelector("#anon-exchange-req pre").textContent =
    "POST /oauth2/token\\nContent-Type: application/x-www-form-urlencoded\\n\\n" + params;
}
function updateAnonClaimPreview() {
  const body = {
    type: "email",
    claim_token: abbrev(state.anon_claim_token),
    email: document.getElementById("anon-claim-email").value,
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

function renderCeremony(containerId, ceremony) {
  document.getElementById(containerId).innerHTML =
    '<div class="note">' +
    '<p style="margin: 0 0 .5rem; color: var(--brand-text);"><strong>Show the user:</strong></p>' +
    '<p style="margin: 0 0 .25rem;"><a href="' + escapeHtml(ceremony.verification_uri) + '" target="_blank">' +
      escapeHtml(ceremony.verification_uri) + '</a></p>' +
    '<p style="margin: 0; font-family: ui-monospace, monospace; font-size: 1.4rem; letter-spacing: .3rem; color: var(--brand-text);">Code: ' +
      escapeHtml(ceremony.user_code) + '</p>' +
    '<p style="margin: .5rem 0 0; font-size: .8rem;">Expires in ' + ceremony.expires_in +
      's. Poll interval: ' + ceremony.interval + 's.</p>' +
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
  if (a === "anon-poll") anonPoll();
  if (a === "anon-call-post") anonCallPost();
  if (a === "email-register") emailRegister();
  if (a === "email-poll") emailPoll();
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
  state.anon_identity_assertion = r.body.identity_assertion;
  state.anon_claim_token = r.body.claim_token;
  state.anon_registration_id = r.body.registration_id;
  updateAnonExchangePreview();
  updateAnonClaimPreview();
  markDone("step-3");
  reveal("step-4");
}

async function anonExchange() {
  const r = await formFetch("/oauth2/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: state.anon_identity_assertion,
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
    type: "login_hint",
    claim_token: state.anon_claim_token,
    login_hint: document.getElementById("anon-claim-email").value,
  };
  const r = await jsonFetch("/agent/identity/claim", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("anon-claim-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  renderCeremony("anon-ceremony", r.body.claim_attempt);
  markDone("step-6");
  reveal("step-7");
  document.getElementById("step-8").hidden = false;
}

async function anonPoll() {
  const r = await formFetch("/oauth2/token", {
    grant_type: "urn:workos:agent-auth:grant-type:claim",
    claim_token: state.anon_claim_token,
  });
  document.getElementById("anon-poll-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  /* Claim grant succeeded: response carries access_token + v2 identity_assertion. */
  state.anon_access_token = r.body.access_token;
  state.anon_identity_assertion = r.body.identity_assertion;
  markDone("step-7");
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
  state.email_claim_token = r.body.claim_token;
  state.email_registration_id = r.body.registration_id;
  renderCeremony("email-ceremony", r.body.claim);
  markDone("step-10");
  reveal("step-11");
  document.getElementById("step-12").hidden = false;
}

async function emailPoll() {
  const r = await formFetch("/oauth2/token", {
    grant_type: "urn:workos:agent-auth:grant-type:claim",
    claim_token: state.email_claim_token,
  });
  document.getElementById("email-poll-out").innerHTML = resBlock(r.status, null, r.body, r.ok);
  if (!r.ok) return;
  state.email_access_token = r.body.access_token;
  state.email_identity_assertion = r.body.identity_assertion;
  markDone("step-11");
  markDone("step-12");
  reveal("step-13");
}

async function emailCall() {
  /*
   * The claim grant already returned an access_token alongside the v2
   * identity_assertion — just use it. (The identity_assertion is what the
   * agent uses to mint future access_tokens via jwt-bearer once this one
   * expires.)
   */
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
  state.identity_assertion = r.body.identity_assertion;
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
