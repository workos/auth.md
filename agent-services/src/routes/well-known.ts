import { Router } from "express";
import { config } from "../config.js";

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
    agent_auth: {
      skill: `${config.baseUrl}/auth.md`,
      register_uri: `${config.baseUrl}/agent/auth`,
      claim_uri: `${config.baseUrl}/agent/auth/claim`,
      revocation_uri: `${config.baseUrl}/agent/auth/revoke`,
      identity_types_supported: ["anonymous", "identity_assertion"],
      anonymous: {},
      identity_assertion: {
        assertion_types_supported: [
          "urn:ietf:params:oauth:token-type:id-jag",
          "verified_email",
        ],
      },
      events_supported: [
        "https://schemas.workos.com/events/agent/auth/identity/assertion/revoked",
      ],
    },
  });
});
