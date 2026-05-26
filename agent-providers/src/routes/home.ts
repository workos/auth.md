import { Router } from "express";
import { config } from "../config.js";
import { users } from "../store.js";

export const homeRouter = Router();

homeRouter.get("/", (_req, res) => {
  const seeded = Array.from(users.values()).map((u) => ({
    email: u.email,
    name: u.name ?? u.email,
  }));
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderHtml(seeded));
});

function renderHtml(seeded: { email: string; name: string }[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agent Auth Provider — Interactive Demo</title>
<style>
  :root {
    --brand-primary: #6D6DF2;
    --brand-primary-hover: #5252D9;
    --brand-success: #3FF1C7;
    --brand-text: #030527;
    --brand-bg: #FFFFFF;
    --error: #e55039;
    --error-bg: #fde9e6;
    --muted: rgba(3, 5, 39, .65);
    --border: rgba(3, 5, 39, .12);
    --surface-soft: rgba(3, 5, 39, .04);
    --jwt-bg: rgba(109, 109, 242, .08);
    --jwt-border: rgba(109, 109, 242, .25);
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: var(--brand-text); background: var(--brand-bg); }
  h1 { margin-bottom: .25rem; }
  h2 { margin-top: 0; font-size: 1.1rem; }
  h2 .num { display: inline-block; width: 1.6rem; height: 1.6rem; line-height: 1.6rem; text-align: center; background: var(--brand-primary); color: white; border-radius: 50%; font-size: .85rem; margin-right: .5rem; vertical-align: 1px; }
  .sub { color: var(--muted); margin-top: 0; }
  section { border: 1px solid var(--border); border-radius: .5rem; padding: 1rem 1.25rem; margin: 1rem 0; background: var(--brand-bg); }
  section[hidden] { display: none; }
  section.active { border-color: var(--brand-primary); box-shadow: 0 0 0 3px rgba(109, 109, 242, .15); }
  button { font-size: .95rem; padding: .4rem .9rem; margin: .25rem .4rem .25rem 0; border-radius: .3rem; border: 1px solid var(--border); background: var(--brand-bg); color: var(--brand-text); cursor: pointer; }
  button.primary { background: var(--brand-primary); color: white; border-color: var(--brand-primary); }
  button.primary:hover { background: var(--brand-primary-hover); }
  button:hover { border-color: var(--brand-primary); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  input, select { font-size: .95rem; padding: .3rem .5rem; border: 1px solid var(--border); border-radius: .3rem; font-family: inherit; color: var(--brand-text); background: var(--brand-bg); }
  input { width: 100%; max-width: 28rem; }
  label { display: block; margin-top: .5rem; font-size: .85rem; color: var(--muted); }
  label input, label select { display: block; margin-top: .2rem; }
  .label { display: inline-block; font-size: .7rem; text-transform: uppercase; font-weight: 600; color: var(--muted); letter-spacing: .05em; margin: .5rem 0 .25rem; }
  .req, .res { background: var(--surface-soft); border: 1px solid var(--border); border-radius: .3rem; padding: .6rem .75rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .78rem; overflow-x: auto; }
  .req { border-left: 3px solid var(--brand-primary); }
  .res { border-left: 3px solid var(--brand-success); }
  .res.error { border-left-color: var(--error); background: var(--error-bg); }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; }
  code { background: var(--surface-soft); padding: .05rem .3rem; border-radius: .2rem; font-size: .9em; }
  .jwt-decoded { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-top: .5rem; }
  .jwt-decoded > div { background: var(--jwt-bg); border: 1px solid var(--jwt-border); border-radius: .3rem; padding: .5rem .75rem; }
  .jwt-decoded h3 { margin: 0 0 .25rem; font-size: .8rem; color: var(--brand-primary-hover); text-transform: uppercase; letter-spacing: .04em; }
  .reset { float: right; }
  .badge { display: inline-block; font-size: .7rem; padding: .1rem .4rem; border-radius: .25rem; background: var(--surface-soft); color: var(--muted); font-family: ui-monospace, monospace; margin-left: .3rem; }
  .done .num { background: var(--brand-success); color: var(--brand-text); }
</style>
</head>
<body>
<h1>Agent Auth Provider</h1>
<p class="sub">Interactive walk-through of the ID-JAG flow. Each step shows the endpoint it calls, the payload, and the response. <button class="reset" type="button" id="reset">Reset</button></p>

<section id="step-1" class="active">
  <h2><span class="num">1</span>Log in</h2>
  <p>Pick a seeded user. The returned session token stands in for however your real IdP tracks authenticated users.</p>
  <div class="label">Request</div>
  <div class="req"><pre>POST /login
{ "email": "..." }</pre></div>
  <div id="login-buttons"></div>
  <div id="login-out"></div>
</section>

<section id="step-2" hidden>
  <h2><span class="num">2</span>Record consent</h2>
  <p>Before the provider will mint an ID-JAG, the user must consent to asserting their identity to the target audience. The spec's <code>once</code> / <code>always</code> choice maps to the <code>mode</code> field.</p>
  <label>Audience
    <input id="grant-audience" value="${config.consumerUrl}">
  </label>
  <label>Mode
    <select id="grant-mode">
      <option value="always">always — persists until revoked</option>
      <option value="once">once — marked consumed on first mint</option>
    </select>
  </label>
  <label>Revocation URI (optional)
    <input id="grant-revoke" value="${config.consumerUrl}/agent/event/notify" placeholder="${config.consumerUrl}/agent/event/notify">
  </label>
  <div class="label">Request</div>
  <div class="req" id="grant-req"><pre></pre></div>
  <button class="primary" type="button" data-action="grant">Grant consent</button>
  <div id="grant-out"></div>
</section>

<section id="step-3" hidden>
  <h2><span class="num">3</span>Mint ID-JAG</h2>
  <p>With a grant on file, the agent exchanges the user's session for an audience-scoped identity assertion. The optional fields are passed through into the signed JWT claims.</p>
  <label>Resource (optional)
    <input id="mint-resource" value="${config.consumerUrl}/api/">
  </label>
  <label>Agent platform (optional)
    <input id="mint-platform" value="agent-desktop">
  </label>
  <label>Agent context ID (optional)
    <input id="mint-context" value="chat_abc">
  </label>
  <div class="label">Request</div>
  <div class="req" id="mint-req"><pre></pre></div>
  <button class="primary" type="button" data-action="mint">Mint ID-JAG</button>
  <div id="mint-out"></div>
</section>

<section id="step-4" hidden>
  <h2><span class="num">4</span>Verify the signature</h2>
  <p>Services fetch the JWKS and verify the ID-JAG before trusting any of its claims. We do it here in the browser with <code>jose</code>, against this provider's live JWKS endpoint.</p>
  <button class="primary" type="button" data-action="verify">Verify against JWKS</button>
  <div id="verify-out"></div>
</section>

<section id="step-5" hidden>
  <h2><span class="num">5</span>Exchange for an identity_assertion at the consumer</h2>
  <p>With a valid ID-JAG, the agent POSTs it to the consumer's <code>/agent/register</code> endpoint. The consumer verifies the signature against <em>this</em> provider's JWKS, matches or provisions a user, and returns a service-signed <code>identity_assertion</code>. The agent then trades that assertion at the consumer's <code>/oauth2/token</code> (RFC 7523 JWT-bearer) for an access_token and calls <code>/api/resource</code>. Requires the consumer sample running at the audience URL.</p>
  <div class="label">Request</div>
  <div class="req" id="exchange-req"><pre></pre></div>
  <button class="primary" type="button" data-action="exchange">Exchange at consumer</button>
  <button type="button" data-action="call-resource" id="call-resource" disabled>Exchange token &amp; call /api/resource</button>
  <div id="exchange-out"></div>
</section>

<section id="step-6" hidden>
  <h2><span class="num">6</span>Revoke grant</h2>
  <p>Deleting a grant removes it locally. If a <code>revocation_uri</code> was recorded, the provider first POSTs a <code>logout+jwt</code> there; if the call fails, the grant is retained and the endpoint returns 500. Any credentials the consumer issued for this delegation are invalidated.</p>
  <div class="label">Request</div>
  <div class="req" id="revoke-req"><pre></pre></div>
  <button class="primary" type="button" data-action="revoke">Revoke</button>
  <div id="revoke-out"></div>
</section>

<script type="module">
import { jwtVerify, createRemoteJWKSet } from "https://esm.sh/jose@5";

const SEEDED = ${JSON.stringify(seeded)};
const state = {};

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}
function jsonStr(v) { return JSON.stringify(v, null, 2); }
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}
function resBlock(status, body, ok) {
  const cls = ok ? "res" : "res error";
  const text = body === undefined || body === "" ? "(no body)" : (typeof body === "string" ? body : jsonStr(body));
  return '<div class="label">Response ' + status + '</div>' +
         '<div class="' + cls + '"><pre>' + escapeHtml(text) + '</pre></div>';
}

async function jsonFetch(path, init = {}) {
  const headers = { "content-type": "application/json", ...(init.headers || {}) };
  if (state.session) headers.authorization = "Bearer " + state.session;
  const r = await fetch(path, { ...init, headers });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : ""; } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
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
function resetFrom(n) {
  for (let i = n; i <= 6; i++) {
    const el = document.getElementById("step-" + i);
    if (!el) continue;
    el.hidden = true;
    el.classList.remove("active", "done");
    const out = el.querySelector("[id$='-out']");
    if (out) out.innerHTML = "";
  }
  delete state.grant;
  delete state.audience;
  delete state.assertion;
  delete state.credential;
  delete state.credentialType;
  const callBtn = document.getElementById("call-resource");
  if (callBtn) callBtn.disabled = true;
  const recallBtn = document.getElementById("recall-resource");
  if (recallBtn) recallBtn.disabled = true;
  updateRevokePreview();
  updateExchangePreview();
}

// Seed login buttons
const lb = document.getElementById("login-buttons");
for (const u of SEEDED) {
  const b = document.createElement("button");
  b.className = "primary";
  b.textContent = "Log in as " + u.name;
  b.dataset.email = u.email;
  b.addEventListener("click", () => login(u.email));
  lb.appendChild(b);
}

// Live request previews
function updateGrantPreview() {
  const body = {
    audience: document.getElementById("grant-audience").value,
    mode: document.getElementById("grant-mode").value,
  };
  const rev = document.getElementById("grant-revoke").value.trim();
  if (rev) body.revocation_uri = rev;
  document.querySelector("#grant-req pre").textContent =
    "POST /grants\\nAuthorization: Bearer <session>\\n\\n" + jsonStr(body);
}
function updateMintPreview() {
  const body = { audience: document.getElementById("grant-audience").value };
  const res = document.getElementById("mint-resource").value.trim();
  const plat = document.getElementById("mint-platform").value.trim();
  const ctx = document.getElementById("mint-context").value.trim();
  if (res) body.resource = res;
  if (plat) body.agent_platform = plat;
  if (ctx) body.agent_context_id = ctx;
  document.querySelector("#mint-req pre").textContent =
    "POST /id-jag\\nAuthorization: Bearer <session>\\n\\n" + jsonStr(body);
}
function updateRevokePreview() {
  const id = state.grant ? state.grant.id : "<grant_id>";
  document.querySelector("#revoke-req pre").textContent =
    "DELETE /grants/" + id + "\\nAuthorization: Bearer <session>";
}
function updateExchangePreview() {
  const aud = state.audience || document.getElementById("grant-audience").value;
  const assertionHint = state.assertion ? state.assertion.slice(0, 40) + "..." : "eyJhbGc...";
  document.querySelector("#exchange-req pre").textContent =
    "POST " + aud + "/agent/register\\nContent-Type: application/json\\n\\n" + jsonStr({
      type: "identity_assertion",
      assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
      assertion: assertionHint,
    });
}
document.querySelectorAll("#step-2 input, #step-2 select").forEach((el) => el.addEventListener("input", updateGrantPreview));
document.querySelectorAll("#step-3 input").forEach((el) => el.addEventListener("input", updateMintPreview));
updateGrantPreview();
updateMintPreview();
updateRevokePreview();
updateExchangePreview();

// Button dispatch
document.body.addEventListener("click", (e) => {
  const a = e.target instanceof HTMLElement ? e.target.dataset.action : null;
  if (!a) return;
  if (a === "grant") grant();
  if (a === "mint") mint();
  if (a === "verify") verify();
  if (a === "exchange") exchange();
  if (a === "call-resource") callResource();
  if (a === "revoke") revoke();
});
document.getElementById("reset").addEventListener("click", () => location.reload());

// Actions
async function login(email) {
  resetFrom(2);
  const r = await jsonFetch("/login", { method: "POST", body: JSON.stringify({ email }) });
  document.getElementById("login-out").innerHTML = resBlock(r.status, r.body, r.ok);
  if (!r.ok) return;
  state.session = r.body.session_token;
  state.user = r.body.user;
  markDone("step-1");
  reveal("step-2");
}

async function grant() {
  resetFrom(3);
  const body = {
    audience: document.getElementById("grant-audience").value,
    mode: document.getElementById("grant-mode").value,
  };
  const rev = document.getElementById("grant-revoke").value.trim();
  if (rev) body.revocation_uri = rev;

  const r = await jsonFetch("/grants", { method: "POST", body: JSON.stringify(body) });
  document.getElementById("grant-out").innerHTML = resBlock(r.status, r.body, r.ok);
  if (!r.ok) return;
  state.grant = r.body;
  state.audience = body.audience;
  updateRevokePreview();
  markDone("step-2");
  reveal("step-3");
}

async function mint() {
  const body = { audience: state.audience };
  const res = document.getElementById("mint-resource").value.trim();
  const plat = document.getElementById("mint-platform").value.trim();
  const ctx = document.getElementById("mint-context").value.trim();
  if (res) body.resource = res;
  if (plat) body.agent_platform = plat;
  if (ctx) body.agent_context_id = ctx;

  const r = await jsonFetch("/id-jag", { method: "POST", body: JSON.stringify(body) });
  let html = resBlock(r.status, r.body, r.ok);
  if (r.ok) {
    state.assertion = r.body.assertion;
    const [h, p] = state.assertion.split(".");
    const header = JSON.parse(b64urlDecode(h));
    const payload = JSON.parse(b64urlDecode(p));
    html += '<div class="jwt-decoded">' +
      '<div><h3>Header</h3><pre>' + escapeHtml(jsonStr(header)) + '</pre></div>' +
      '<div><h3>Payload</h3><pre>' + escapeHtml(jsonStr(payload)) + '</pre></div>' +
      '</div>';
  }
  document.getElementById("mint-out").innerHTML = html;
  if (!r.ok) return;
  markDone("step-3");
  reveal("step-4");
}

async function verify() {
  try {
    const jwks = createRemoteJWKSet(new URL("/.well-known/jwks.json", location.origin));
    const res = await jwtVerify(state.assertion, jwks, {
      issuer: location.origin,
      audience: state.audience,
      typ: "oauth-id-jag+jwt",
    });
    document.getElementById("verify-out").innerHTML =
      '<div class="label">jose.jwtVerify → OK</div>' +
      '<div class="res"><pre>Signature valid. Protected header:\\n' +
      escapeHtml(jsonStr(res.protectedHeader)) + '</pre></div>';
    markDone("step-4");
    updateExchangePreview();
    reveal("step-5");
  } catch (err) {
    document.getElementById("verify-out").innerHTML =
      '<div class="label">jose.jwtVerify → FAIL</div>' +
      '<div class="res error"><pre>' + escapeHtml(err.message || String(err)) + '</pre></div>';
  }
}

async function exchange() {
  const body = {
    type: "identity_assertion",
    assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
    assertion: state.assertion,
  };
  let r;
  try {
    const resp = await fetch(state.audience + "/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let respBody; try { respBody = text ? JSON.parse(text) : ""; } catch { respBody = text; }
    r = { status: resp.status, ok: resp.ok, body: respBody };
  } catch (err) {
    document.getElementById("exchange-out").innerHTML =
      '<div class="label">fetch → FAIL</div>' +
      '<div class="res error"><pre>Could not reach ' + escapeHtml(state.audience) +
      '. Is the consumer sample running on that URL?\\n\\n' +
      escapeHtml(err.message || String(err)) + '</pre></div>';
    return;
  }
  document.getElementById("exchange-out").innerHTML = resBlock(r.status, r.body, r.ok);
  if (!r.ok) return;
  state.identity_assertion = r.body.identity_assertion;
  document.getElementById("call-resource").disabled = !state.identity_assertion;
  markDone("step-5");
  reveal("step-6");
}

async function callResource() {
  // RFC 7523 JWT-bearer exchange: trade the service-signed identity_assertion
  // for a short-lived access_token, then use that access_token at the API.
  const tokenUrl = state.audience + "/oauth2/token";
  const tokenParams = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: state.identity_assertion,
  });
  let tokR;
  try {
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    });
    const text = await resp.text();
    let respBody; try { respBody = text ? JSON.parse(text) : ""; } catch { respBody = text; }
    tokR = { status: resp.status, ok: resp.ok, body: respBody };
  } catch (err) {
    document.getElementById("exchange-out").innerHTML +=
      '<div class="label">POST /oauth2/token → FAIL</div>' +
      '<div class="res error"><pre>' + escapeHtml(err.message || String(err)) + '</pre></div>';
    return;
  }
  document.getElementById("exchange-out").innerHTML +=
    '<div class="label">POST /oauth2/token → ' + tokR.status + '</div>' +
    '<div class="' + (tokR.ok ? 'res' : 'res error') + '"><pre>' +
    escapeHtml(jsonStr(tokR.body)) + '</pre></div>';
  if (!tokR.ok) return;
  state.credential = tokR.body.access_token;

  const url = state.audience + "/api/resource";
  let r;
  try {
    const resp = await fetch(url, {
      headers: { authorization: "Bearer " + state.credential },
    });
    const text = await resp.text();
    let respBody; try { respBody = text ? JSON.parse(text) : ""; } catch { respBody = text; }
    r = { status: resp.status, ok: resp.ok, body: respBody };
  } catch (err) {
    document.getElementById("exchange-out").innerHTML +=
      '<div class="label">GET /api/resource → FAIL</div>' +
      '<div class="res error"><pre>' + escapeHtml(err.message || String(err)) + '</pre></div>';
    return;
  }
  document.getElementById("exchange-out").innerHTML +=
    '<div class="label">GET ' + escapeHtml(url) + ' → ' + r.status + '</div>' +
    '<div class="' + (r.ok ? 'res' : 'res error') + '"><pre>' +
    escapeHtml(jsonStr(r.body)) + '</pre></div>';
}

async function revoke() {
  const r = await jsonFetch("/grants/" + state.grant.id, { method: "DELETE" });
  document.getElementById("revoke-out").innerHTML = resBlock(r.status, r.body, r.ok);
  if (!r.ok) return;
  markDone("step-6");

  // If a credential was exchanged at the consumer, prove it's now rejected.
  // A 401 here is the expected outcome — it confirms the consumer processed
  // the logout+jwt. A 200 would mean revocation didn't take effect.
  if (state.credential) {
    const url = state.audience + "/api/resource";
    try {
      const resp = await fetch(url, {
        headers: { authorization: "Bearer " + state.credential },
      });
      const text = await resp.text();
      let body; try { body = text ? JSON.parse(text) : ""; } catch { body = text; }
      const rejected = resp.status === 401;
      const label = rejected
        ? "Post-revoke GET " + escapeHtml(url) + " → " + resp.status + " (expected — credential rejected)"
        : "Post-revoke GET " + escapeHtml(url) + " → " + resp.status + " (unexpected — revocation did not take effect)";
      document.getElementById("revoke-out").innerHTML +=
        '<div class="label">' + label + '</div>' +
        '<div class="' + (rejected ? 'res' : 'res error') + '"><pre>' +
        escapeHtml(jsonStr(body)) + '</pre></div>';
    } catch (err) {
      document.getElementById("revoke-out").innerHTML +=
        '<div class="label">Post-revoke GET /api/resource → FAIL</div>' +
        '<div class="res error"><pre>' + escapeHtml(err.message || String(err)) + '</pre></div>';
    }
  }

  // Clear now-stale steps 2..5 — grant is gone, so the ID-JAG, verify, and
  // exchanged credential from this run no longer correspond to an active delegation.
  for (let i = 2; i <= 5; i++) {
    const el = document.getElementById("step-" + i);
    if (!el) continue;
    el.hidden = true;
    el.classList.remove("active", "done");
    const out = el.querySelector("[id$='-out']");
    if (out) out.innerHTML = "";
  }
  delete state.grant;
  delete state.assertion;
  delete state.credential;
  delete state.credentialType;
  const callBtn = document.getElementById("call-resource");
  if (callBtn) callBtn.disabled = true;
  updateRevokePreview();
  updateExchangePreview();

  document.getElementById("revoke-out").innerHTML +=
    '<div class="label">Previous steps cleared</div>' +
    '<div class="res"><pre>Grant, minted ID-JAG, and exchanged credential are no longer valid. Record a new grant at step 2 to start over.</pre></div>';
  document.getElementById("step-2").hidden = false;
}
</script>
</body></html>`;
}
