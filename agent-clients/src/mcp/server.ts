#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentAuthClient } from "../core/client.js";
import { ProtocolError } from "../core/types.js";

/**
 * MCP stdio server exposing the auth.md registration flow as three tools:
 * authmd_authenticate, authmd_complete_claim, authmd_fetch. Works in
 * Claude Desktop (via the .mcpb bundle), Claude Code (`claude mcp add`),
 * and Codex (`codex mcp add`).
 */
const client = new AgentAuthClient();

const server = new McpServer({
  name: "@workos/auth.md-client",
  version: "0.1.0",
});

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  if (error instanceof ProtocolError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { error: error.code, message: error.message, status: error.status },
            null,
            2,
          ),
        },
      ],
    };
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: String(error) }],
  };
}

server.tool(
  "authmd_authenticate",
  "Authenticate to a service that supports auth.md agentic registration. Reuses stored credentials for the issuer when possible; otherwise registers (service_auth when an email is given, anonymous otherwise, or identity_assertion when an ID-JAG is supplied) and exchanges for an access token. Returns ready credentials, or claim ceremony materials when the user must confirm in a browser.",
  {
    issuer: z.string().describe("Authorization server issuer URL"),
    email: z
      .string()
      .optional()
      .describe("The user's email (login_hint) for service_auth registration"),
    resource: z
      .string()
      .optional()
      .describe("RFC 8707 resource URI to pin the access token to"),
    id_jag: z
      .string()
      .optional()
      .describe("Pre-minted ID-JAG JWT for identity_assertion registration"),
    force_reregister: z
      .boolean()
      .optional()
      .describe("Ignore stored credentials and register fresh"),
  },
  async ({ issuer, email, resource, id_jag, force_reregister }) => {
    try {
      const result = await client.authenticate({
        issuer,
        email,
        resource,
        idJag: id_jag,
        forceReregister: force_reregister,
      });
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "authmd_complete_claim",
  "Complete an in-flight claim ceremony. Call after the user opened the verification_uri, signed in, and read back the code shown on the page. Returns ready credentials.",
  {
    issuer: z.string().describe("Authorization server issuer URL"),
    user_code: z
      .string()
      .describe("The code the user read back from the claim page"),
    resource: z
      .string()
      .optional()
      .describe("RFC 8707 resource URI to pin the access token to"),
  },
  async ({ issuer, user_code, resource }) => {
    try {
      const result = await client.completeClaim(issuer, user_code, resource);
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "authmd_fetch",
  "Make an authenticated HTTP request to a service registered via authmd_authenticate. Injects the bearer token and transparently refreshes expired credentials.",
  {
    issuer: z.string().describe("Authorization server issuer URL"),
    url: z.string().describe("Absolute URL to request"),
    method: z.string().optional().describe("HTTP method (default GET)"),
    headers: z.record(z.string()).optional().describe("Extra request headers"),
    body: z.string().optional().describe("Request body"),
    resource: z
      .string()
      .optional()
      .describe("RFC 8707 resource URI to pin the access token to"),
  },
  async ({ issuer, url, method, headers, body, resource }) => {
    try {
      const result = await client.fetchWithAuth({
        issuer,
        url,
        method,
        headers,
        body,
        resource,
      });
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
