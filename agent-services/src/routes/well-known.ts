import { Router } from "express";
import { config } from "../config.js";
import { IDENTITY_ASSERTION_REVOKED_SCHEMA } from "./agent-auth.js";

export const wellKnownRouter = Router();

wellKnownRouter.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    resource: config.resource,
    resource_name: "Agent Auth Consumer",
    resource_logo_uri: `${config.baseUrl}/logo.png`,
    authorization_servers: [config.baseUrl],
    scopes_supported: config.scopesSupported,
    bearer_methods_supported: ["header"],
  });
});

wellKnownRouter.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    resource: config.resource,
    authorization_servers: [config.baseUrl],
    scopes_supported: config.scopesSupported,
    bearer_methods_supported: ["header"],

    issuer: config.baseUrl,
    token_endpoint: `${config.baseUrl}${config.tokenEndpointPath}`,
    revocation_endpoint: `${config.baseUrl}${config.revocationEndpointPath}`,
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],

    agent_auth: {
      skill: `${config.baseUrl}/auth.md`,
      identity_endpoint: `${config.baseUrl}${config.identityEndpointPath}`,
      claim_endpoint: `${config.baseUrl}${config.claimEndpointPath}`,
      events_endpoint: `${config.baseUrl}${config.eventsEndpointPath}`,
      identity_types_supported: [
        "anonymous",
        "identity_assertion",
        "service_auth",
      ],
      identity_assertion: {
        assertion_types_supported: ["urn:ietf:params:oauth:token-type:id-jag"],
      },
      events_supported: [IDENTITY_ASSERTION_REVOKED_SCHEMA],
    },
  });
});
