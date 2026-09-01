import { ports } from "shared";

const baseUrl = `http://localhost:${ports.consumer}`;
const providerUrl = `http://localhost:${ports.provider}`;

export const config = Object.freeze({
  port: ports.consumer,
  baseUrl,
  resource: `${baseUrl}/api/`,
  prmUrl: `${baseUrl}/.well-known/oauth-protected-resource`,
  /**
   * Trusted issuer list for ID-JAGs. The `displayName` is what users see on
   * the step-up confirmation page ("Cursor is asking to link this account…")
   * — service-controlled so a provider can't set its own marketing copy. In
   * production this would typically come from CIMD (Client ID Metadata
   * Document, RFC draft) with the service still gating which `client_name`
   * values it renders.
   */
  trustedIssuers: [{ iss: providerUrl, displayName: "Agent Provider" }],
  scopesSupported: ["api.read", "api.write"],
  preClaimScopes: ["api.read"],
  postClaimScopes: ["api.read", "api.write"],
  accessTokenTtlSeconds: 3600,
  /**
   * Lifetime of service-signed identity_assertions returned by /agent/identity.
   * Agents re-exchange the assertion at /oauth2/token to refresh access_tokens
   * within this window; when it expires, the agent re-calls /agent/identity.
   */
  serviceAssertionTtlSeconds: 3600,
  /**
   * Lifetime of the rotating refresh token issued to service_auth and claimed
   * registrations at claim/complete. Longer than the assertion — it's how the
   * agent mints a fresh assertion once the current one expires, via
   * /agent/identity (type: refresh).
   */
  refreshTokenTtlSeconds: 30 * 86400,
  anonymousTtlSeconds: 86400,
  /**
   * Maximum age of the upstream user authentication carried in an ID-JAG's
   * auth_time claim. ID-JAGs whose underlying login is older than this are
   * rejected with login_required; the agent should refresh the user's
   * session at its provider and request a fresh ID-JAG.
   */
  idJagMaxAuthAgeSeconds: 3600,
  claimViewTokenTtlSeconds: 600,
  /** Lifetime of the user_code revealed on the claim page (RFC 8628 shape). */
  userCodeTtlSeconds: 600,
  /** Lifetime of the cookie-bound session minted at /login. */
  sessionTtlSeconds: 86400,
  /**
   * Secret for express-session cookie signing. In production this would be
   * a high-entropy value held outside the repo; for the demo we accept a
   * stable default so cookies survive dev-server restarts.
   */
  sessionSecret: process.env.SESSION_SECRET ?? "demo-secret-do-not-ship",
  clockSkewSeconds: 60,
  /** RFC 7523 JWT-bearer grant endpoint. */
  tokenEndpointPath: "/oauth2/token",
  /** RFC 7009 token revocation endpoint. */
  revocationEndpointPath: "/oauth2/revoke",
  /** Agent identity-assertion endpoint (profile extension). */
  identityEndpointPath: "/agent/identity",
  /** Claim ceremony endpoint, nested under identity. */
  claimEndpointPath: "/agent/identity/claim",
  /** RFC 8935 SET receiver path (provider-pushed identity events). */
  eventsEndpointPath: "/agent/event/notify",
  corsOrigins: [providerUrl],
  keyPath: ".keys/signing-key.json",
});
