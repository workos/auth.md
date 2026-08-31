import { AgentAuthClient } from "../core/client.js";
import { ProtocolError } from "../core/types.js";

/**
 * pi extension adapter. pi extensions are TypeScript modules that register
 * tools directly, so this calls the shared core without an MCP hop.
 *
 * Structural interface for the slice of pi's extension API we use, so the
 * adapter compiles without a dependency on pi itself.
 */
interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface PiLike {
  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(args: Record<string, unknown>): Promise<PiToolResult>;
  }): void;
}

function json(value: unknown): PiToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): PiToolResult {
  const payload =
    error instanceof ProtocolError
      ? { error: error.code, message: error.message, status: error.status }
      : { error: "unknown_error", message: String(error) };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function strRecord(
  args: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const value = args[key];
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export default function activate(pi: PiLike): void {
  const client = new AgentAuthClient();

  pi.registerTool({
    name: "authmd_authenticate",
    description:
      "Authenticate to a service that supports auth.md agentic registration. Reuses stored credentials for the issuer when possible; otherwise registers and exchanges for an access token. Returns ready credentials, or claim ceremony materials when the user must confirm in a browser.",
    parameters: {
      type: "object",
      properties: {
        issuer: {
          type: "string",
          description: "Authorization server issuer URL",
        },
        email: {
          type: "string",
          description: "The user's email (login_hint) for service_auth",
        },
        resource: { type: "string", description: "RFC 8707 resource URI" },
        id_jag: { type: "string", description: "Pre-minted ID-JAG JWT" },
      },
      required: ["issuer"],
    },
    async execute(args) {
      try {
        const issuer = str(args, "issuer");
        if (!issuer) return failure(new Error("issuer is required"));
        return json(
          await client.authenticate({
            issuer,
            email: str(args, "email"),
            resource: str(args, "resource"),
            idJag: str(args, "id_jag"),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "authmd_complete_claim",
    description:
      "Complete an in-flight claim ceremony with the code the user read back from the service's claim page.",
    parameters: {
      type: "object",
      properties: {
        issuer: {
          type: "string",
          description: "Authorization server issuer URL",
        },
        user_code: { type: "string", description: "Code the user read back" },
        resource: { type: "string", description: "RFC 8707 resource URI" },
      },
      required: ["issuer", "user_code"],
    },
    async execute(args) {
      try {
        const issuer = str(args, "issuer");
        const userCode = str(args, "user_code");
        if (!issuer || !userCode) {
          return failure(new Error("issuer and user_code are required"));
        }
        return json(
          await client.completeClaim(issuer, userCode, str(args, "resource")),
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "authmd_fetch",
    description:
      "Make an authenticated HTTP request to a service registered via authmd_authenticate. Injects the bearer token and refreshes expired credentials.",
    parameters: {
      type: "object",
      properties: {
        issuer: {
          type: "string",
          description: "Authorization server issuer URL",
        },
        url: { type: "string", description: "Absolute URL to request" },
        method: { type: "string", description: "HTTP method (default GET)" },
        headers: {
          type: "object",
          description: "Extra request headers",
          additionalProperties: { type: "string" },
        },
        body: { type: "string", description: "Request body" },
        resource: { type: "string", description: "RFC 8707 resource URI" },
      },
      required: ["issuer", "url"],
    },
    async execute(args) {
      try {
        const issuer = str(args, "issuer");
        const url = str(args, "url");
        if (!issuer || !url) {
          return failure(new Error("issuer and url are required"));
        }
        return json(
          await client.fetchWithAuth({
            issuer,
            url,
            method: str(args, "method"),
            headers: strRecord(args, "headers"),
            body: str(args, "body"),
            resource: str(args, "resource"),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  });
}
