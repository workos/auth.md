import { ports } from "shared";

const baseUrl = `http://localhost:${ports.consumer}`;
const providerUrl = `http://localhost:${ports.provider}`;

export const config = Object.freeze({
  port: ports.consumer,
  baseUrl,
  resource: `${baseUrl}/api/`,
  prmUrl: `${baseUrl}/.well-known/oauth-protected-resource`,
  trustedIssuers: [providerUrl],
  scopesSupported: ["api.read", "api.write"],
  preClaimScopes: ["api.read"],
  postClaimScopes: ["api.read", "api.write"],
  accessTokenTtlSeconds: 3600,
  anonymousTtlSeconds: 86400,
  claimViewTokenTtlSeconds: 600,
  otpTtlSeconds: 600,
  clockSkewSeconds: 60,
  // Maximum age of the upstream user authentication carried in an ID-JAG's
  // auth_time claim. Tokens whose underlying login is older than this are
  // rejected; the agent should refresh the user's session at its provider
  // and request a fresh ID-JAG.
  idJagMaxAuthAgeSeconds: 3600,
  corsOrigins: [providerUrl],
  mailDir: ".mail",
  mailUrlPath: "/mail",
});
